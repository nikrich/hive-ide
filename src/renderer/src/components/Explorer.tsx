/**
 * Hive IDE — multi-root file explorer (STORY-025).
 *
 * Replaces the seed-driven tree from STORY-007 with a real, store-driven
 * explorer. Each entry in `project.repos` renders as a VSCode-style
 * top-level expandable root; children are fetched lazily via
 * `window.hive.fs.listDir` the first time a folder is expanded and cached
 * in the workspace store for the rest of the session.
 *
 * Surfaces owned by this story:
 *
 * - Multi-root tree (one expandable node per repo)
 * - Lazy directory loading + caching
 * - Persisted `expandedSet` (driven through store actions so STORY-019's
 *   `electron-store` snapshot picks up the change)
 * - Selected-node tracking in the store
 * - File-open: `fs.readFile` → `loadContent` → `openTab` → `setActive`
 * - Context menu: New File / New Folder / Rename / Delete / Refresh /
 *   Reveal in Finder / Copy Path
 * - Inline-input UX for new-file, new-folder, rename
 * - Keyboard shortcuts: ⌘N, ⌘⇧N, ⌘R, Enter (rename), ⌫ / Del (delete)
 *
 * Deferred to later REQs: git M/A/U markers (chip slot stays empty), agent
 * presence dots (the prototype hint that "intermediate is editing oauth.ts"
 * — comes back when the Hive REQ wires real agents), drag-and-drop reorder,
 * multi-select, and project-wide search.
 *
 * No `any` is permitted in this file — see `tsconfig.web.json`'s `strict`.
 * The shortcut handler narrows `KeyboardEvent.target` via `Node.contains`
 * rather than casting.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'

import { Icon, fileIcon } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'
import { nextDrillTarget } from '../lib/folderDrill'
import type { DirEntry, Repo } from '../../../types/workspace'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
//
// We sniff the separator off the path itself rather than reaching for
// `window.hive.platform` so unit tests and Storybook-style mounts don't have
// to stub the preload bridge for every call. Windows absolute paths contain
// `\\`; POSIX-style paths don't.

function sepOf(p: string): '\\' | '/' {
  return p.includes('\\') ? '\\' : '/'
}

function basename(p: string): string {
  const s = sepOf(p)
  const i = p.lastIndexOf(s)
  return i === -1 ? p : p.slice(i + 1)
}

function dirname(p: string): string {
  const s = sepOf(p)
  const i = p.lastIndexOf(s)
  if (i <= 0) return s
  return p.slice(0, i)
}

function joinPath(parent: string, name: string): string {
  const s = sepOf(parent)
  return parent.endsWith(s) ? parent + name : parent + s + name
}

/** Sort children: directories first, then files; alphabetical within each. */
function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

// ---------------------------------------------------------------------------
// Pending-operation state — inline input shown under or in place of a row
// ---------------------------------------------------------------------------

type PendingOp =
  | { kind: 'new-file'; parentPath: string }
  | { kind: 'new-folder'; parentPath: string }
  | { kind: 'rename'; path: string; isDir: boolean }

interface ContextMenuState {
  x: number
  y: number
  path: string
  isDir: boolean
  /** True when the user right-clicked an explorer root (a repo). */
  isRepoRoot: boolean
}

type ContextAction =
  | 'new-file'
  | 'new-folder'
  | 'rename'
  | 'delete'
  | 'refresh'
  | 'reveal'
  | 'copy-path'

// ---------------------------------------------------------------------------
// Empty-Explorer placeholder (no project)
// ---------------------------------------------------------------------------

function EmptyExplorer() {
  return (
    <aside className="explorer" data-empty="true">
      <div className="exp-head">
        <span className="ttl">Explorer</span>
      </div>
      <div
        style={{
          padding: '12px 14px',
          font: 'var(--t-meta)',
          color: 'var(--fg-3)',
          lineHeight: 1.5,
        }}
      >
        No folder open. Use <span className="kbd">⌘O</span> to open a folder.
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Inline input — used for new-file / new-folder / rename
// ---------------------------------------------------------------------------

interface InlineInputProps {
  initialValue: string
  iconName: string
  tintClass: string
  paddingLeft: number
  onCommit: (value: string) => void
  onCancel: () => void
}

function InlineInput({
  initialValue,
  iconName,
  tintClass,
  paddingLeft,
  onCommit,
  onCancel,
}: InlineInputProps) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    // Pre-select the basename without the extension so rename's first
    // keystroke replaces the name, not the suffix.
    const el = inputRef.current
    if (el) {
      const dot = initialValue.lastIndexOf('.')
      const selEnd = dot > 0 ? dot : initialValue.length
      try {
        el.setSelectionRange(0, selEnd)
      } catch {
        // setSelectionRange throws on some input types — harmless to skip.
      }
    }
  }, [initialValue])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    onCommit(value.trim())
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <form className="row" style={{ paddingLeft }} onSubmit={submit}>
      <span className={'fi ' + tintClass}>
        <Icon name={iconName} size={15} />
      </span>
      <input
        ref={inputRef}
        className="nm explorer-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onCommit(value.trim())}
        onKeyDown={onKeyDown}
        style={{
          background: 'transparent',
          border: '1px solid var(--accent)',
          borderRadius: 3,
          padding: '0 4px',
          color: 'var(--fg-1)',
          font: 'var(--t-body-sm)',
          outline: 'none',
          width: '100%',
        }}
      />
    </form>
  )
}

// ---------------------------------------------------------------------------
// Tree row — file or folder
// ---------------------------------------------------------------------------

interface RowCommon {
  depth: number
  selectedPath: string | null
  expandedSet: Set<string>
  childrenCache: Record<string, DirEntry[]>
  pending: PendingOp | null
  onSelect: (path: string) => void
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean, isRepoRoot: boolean) => void
  onCommitNew: (parentPath: string, name: string, kind: 'file' | 'folder') => void
  onCommitRename: (oldPath: string, newName: string, isDir: boolean) => void
  onCancelPending: () => void
}

interface FolderRowProps extends RowCommon {
  name: string
  path: string
  /** Top-level repo roots get a slightly bolder treatment. */
  isRepoRoot: boolean
}

function FolderRow(props: FolderRowProps) {
  const {
    name,
    path,
    depth,
    isRepoRoot,
    expandedSet,
    childrenCache,
    pending,
    selectedPath,
    onSelect,
    onToggle,
    onContextMenu,
  } = props

  const expanded = expandedSet.has(path)
  const cached = childrenCache[path]
  const cacheChildren = useWorkspaceStore((s) => s.cacheChildren)

  // Local UI state for the lazy fetch. We don't push these into the store —
  // a brief "loading" flicker per folder is a per-row concern.
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!expanded || cached !== undefined) return
    let canceled = false
    setLoading(true)
    setError(null)
    window.hive.fs
      .listDir(path)
      .then((entries) => {
        if (canceled) return
        cacheChildren(path, entries)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (canceled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      canceled = true
    }
  }, [expanded, cached, path, cacheChildren])

  const pad = 6 + depth * 13
  const selected = selectedPath === path
  const isRename = pending?.kind === 'rename' && pending.path === path
  const isInsertingHere =
    pending !== null &&
    (pending.kind === 'new-file' || pending.kind === 'new-folder') &&
    pending.parentPath === path

  const onRowClick = (e: ReactMouseEvent) => {
    e.stopPropagation()
    onSelect(path)
    onToggle(path)
  }

  const onRowContext = (e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onSelect(path)
    onContextMenu(e, path, true, isRepoRoot)
  }

  const sortedChildren = useMemo(
    () => (cached ? sortEntries(cached) : null),
    [cached],
  )

  return (
    <div>
      {isRename ? (
        <InlineInput
          initialValue={basename(path)}
          iconName="folder"
          tintClass="ic-folder"
          paddingLeft={pad}
          onCommit={(value) => props.onCommitRename(path, value, true)}
          onCancel={props.onCancelPending}
        />
      ) : (
        <div
          className={'row' + (selected ? ' sel' : '')}
          style={{
            paddingLeft: pad,
            fontWeight: isRepoRoot ? 600 : undefined,
          }}
          onClick={onRowClick}
          onContextMenu={onRowContext}
          data-path={path}
          data-kind="folder"
        >
          <span className="tw">
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
          </span>
          <span className="fi ic-folder">
            <Icon
              name={
                isRepoRoot
                  ? 'git-branch'
                  : expanded
                    ? 'folder-open'
                    : 'folder'
              }
              size={15}
            />
          </span>
          <span className="nm">{name}</span>
        </div>
      )}

      {expanded && (
        <>
          {loading && cached === undefined && (
            <div
              className="row"
              style={{
                paddingLeft: pad + 14,
                color: 'var(--fg-3)',
                cursor: 'default',
              }}
            >
              <span className="nm">Loading…</span>
            </div>
          )}
          {error && (
            <div
              className="row"
              style={{
                paddingLeft: pad + 14,
                color: 'var(--red-400, #ef4444)',
                cursor: 'default',
              }}
              title={error}
            >
              <span className="nm">Failed to load: {error}</span>
            </div>
          )}
          {sortedChildren?.map((child) => (
            <ChildRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedSet={expandedSet}
              childrenCache={childrenCache}
              pending={pending}
              onSelect={onSelect}
              onToggle={onToggle}
              onOpenFile={props.onOpenFile}
              onContextMenu={onContextMenu}
              onCommitNew={props.onCommitNew}
              onCommitRename={props.onCommitRename}
              onCancelPending={props.onCancelPending}
            />
          ))}
          {isInsertingHere && (
            <InlineInput
              initialValue=""
              iconName={pending.kind === 'new-folder' ? 'folder' : 'file'}
              tintClass={pending.kind === 'new-folder' ? 'ic-folder' : 'ic-md'}
              paddingLeft={pad + 14}
              onCommit={(value) =>
                props.onCommitNew(
                  path,
                  value,
                  pending.kind === 'new-folder' ? 'folder' : 'file',
                )
              }
              onCancel={props.onCancelPending}
            />
          )}
        </>
      )}
    </div>
  )
}

interface ChildRowProps extends RowCommon {
  entry: DirEntry
}

function ChildRow(props: ChildRowProps) {
  const { entry } = props
  if (entry.isDir) {
    return (
      <FolderRow
        name={entry.name}
        path={entry.path}
        isRepoRoot={false}
        depth={props.depth}
        selectedPath={props.selectedPath}
        expandedSet={props.expandedSet}
        childrenCache={props.childrenCache}
        pending={props.pending}
        onSelect={props.onSelect}
        onToggle={props.onToggle}
        onOpenFile={props.onOpenFile}
        onContextMenu={props.onContextMenu}
        onCommitNew={props.onCommitNew}
        onCommitRename={props.onCommitRename}
        onCancelPending={props.onCancelPending}
      />
    )
  }
  return <FileRow {...props} />
}

function FileRow(props: ChildRowProps) {
  const { entry, depth, pending, selectedPath, onSelect, onOpenFile, onContextMenu } = props
  const pad = 6 + depth * 13
  const selected = selectedPath === entry.path
  const isRename = pending?.kind === 'rename' && pending.path === entry.path
  const [iconName, tint] = fileIcon(entry.name)

  if (isRename) {
    return (
      <InlineInput
        initialValue={entry.name}
        iconName={iconName}
        tintClass={tint}
        paddingLeft={pad + 14}
        onCommit={(value) => props.onCommitRename(entry.path, value, false)}
        onCancel={props.onCancelPending}
      />
    )
  }

  return (
    <div
      className={'row' + (selected ? ' sel' : '')}
      style={{ paddingLeft: pad + 14 }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(entry.path)
        onOpenFile(entry.path)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onSelect(entry.path)
        onContextMenu(e, entry.path, false, false)
      }}
      data-path={entry.path}
      data-kind="file"
    >
      <span className={'fi ' + tint}>
        <Icon name={iconName} size={15} />
      </span>
      <span className="nm">{entry.name}</span>
      {/* Git-marker chip slot — intentionally empty until the git REQ. */}
      <span className="git" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

interface ContextMenuProps {
  state: ContextMenuState
  onAction: (action: ContextAction) => void
  onClose: () => void
}

interface MenuEntry {
  action: ContextAction
  label: string
  shortcut?: string
  icon?: string
  /** Hide on repo-roots (you can't rename a repo). */
  hideOnRepoRoot?: boolean
}

const MENU_ENTRIES: ReadonlyArray<MenuEntry | 'sep'> = [
  { action: 'new-file', label: 'New File', shortcut: '⌘N', icon: 'file-plus' },
  { action: 'new-folder', label: 'New Folder', shortcut: '⌘⇧N', icon: 'folder-plus' },
  'sep',
  { action: 'rename', label: 'Rename', shortcut: 'Enter', icon: 'pencil', hideOnRepoRoot: true },
  { action: 'delete', label: 'Delete', shortcut: '⌫', icon: 'trash-2', hideOnRepoRoot: true },
  'sep',
  { action: 'refresh', label: 'Refresh', shortcut: '⌘R', icon: 'refresh-cw' },
  { action: 'reveal', label: 'Reveal in Finder', icon: 'folder-search' },
  { action: 'copy-path', label: 'Copy Path', icon: 'copy' },
]

function ContextMenu({ state, onAction, onClose }: ContextMenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div
        // Invisible scrim — closes the menu on any outside click.
        style={{ position: 'fixed', inset: 0, zIndex: 200 }}
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="ctx-menu"
        style={{
          position: 'fixed',
          top: state.y,
          left: state.x,
          zIndex: 201,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--r-md, 6px)',
          boxShadow: 'var(--sh-pop)',
          minWidth: 220,
          padding: 4,
          font: 'var(--t-body-sm)',
        }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
      >
        {MENU_ENTRIES.map((entry, i) => {
          if (entry === 'sep') {
            return (
              <div
                key={`sep-${i}`}
                style={{
                  height: 1,
                  margin: '4px 0',
                  background: 'var(--border-subtle)',
                }}
              />
            )
          }
          if (entry.hideOnRepoRoot && state.isRepoRoot) return null
          return (
            <button
              key={entry.action}
              type="button"
              role="menuitem"
              onClick={() => onAction(entry.action)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                width: '100%',
                padding: '6px 10px',
                background: 'transparent',
                border: 'none',
                color: 'var(--fg-1)',
                cursor: 'pointer',
                borderRadius: 4,
                textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLButtonElement).style.background =
                  'var(--bg-hover)'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLButtonElement).style.background =
                  'transparent'
              }}
            >
              {entry.icon && <Icon name={entry.icon} size={14} />}
              <span style={{ flex: 1 }}>{entry.label}</span>
              {entry.shortcut && (
                <span style={{ color: 'var(--fg-3)', font: 'var(--t-meta)' }}>
                  {entry.shortcut}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Explorer — top-level component
// ---------------------------------------------------------------------------

export interface ExplorerProps {
  /**
   * The Explorer is fully store-driven; this prop is intentionally empty
   * so callers can render `<Explorer />` without threading any state.
   * Declared as an interface (rather than `Record<string, never>`) so
   * downstream stories can add tracing/cypress hooks without a churn.
   */
  readonly _?: never
}

export function Explorer(_props: ExplorerProps = {}) {
  // ----- store selectors --------------------------------------------------
  const project = useWorkspaceStore((s) => s.project)
  const repos = useWorkspaceStore((s) => s.repos)
  const expandedSet = useWorkspaceStore((s) => s.expandedSet)
  const childrenCache = useWorkspaceStore((s) => s.childrenCache)
  const selectedPath = useWorkspaceStore((s) => s.selectedExplorerPath)
  const openTabs = useWorkspaceStore((s) => s.openTabs)
  const dirtyMap = useWorkspaceStore((s) => s.dirtyMap)

  // ----- store actions ----------------------------------------------------
  const setExpanded = useWorkspaceStore((s) => s.setExpanded)
  const cacheChildren = useWorkspaceStore((s) => s.cacheChildren)
  const invalidateChildren = useWorkspaceStore((s) => s.invalidateChildren)
  const setSelectedExplorerPath = useWorkspaceStore((s) => s.setSelectedExplorerPath)
  const loadContent = useWorkspaceStore((s) => s.loadContent)
  const openTab = useWorkspaceStore((s) => s.openTab)
  const closeTab = useWorkspaceStore((s) => s.closeTab)
  const setActive = useWorkspaceStore((s) => s.setActive)
  const renamePath = useWorkspaceStore((s) => s.renamePath)

  // ----- local UI state ---------------------------------------------------
  const [pending, setPending] = useState<PendingOp | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const explorerRef = useRef<HTMLElement | null>(null)

  // ----- derived: which folder "owns" a new entry / a refresh request -----
  //
  // Selection-folder rules:
  //   1. Folder selected            → that folder
  //   2. File selected              → its parent folder
  //   3. Nothing selected           → first repo (or null if no repos)
  const selectedFolder = useMemo<string | null>(() => {
    if (selectedPath) {
      // We tag rows with data-kind in the DOM, but the safer source of truth
      // is the cache: anything we've successfully listDir'd is a folder.
      if (childrenCache[selectedPath] !== undefined) return selectedPath
      const parent = dirname(selectedPath)
      const entry = childrenCache[parent]?.find((e) => e.path === selectedPath)
      if (entry?.isDir) return selectedPath
      return parent
    }
    return repos[0]?.path ?? null
  }, [selectedPath, childrenCache, repos])

  /** Best-effort directory check for an arbitrary tree path. */
  const isPathDir = useCallback(
    (p: string): boolean => {
      if (repos.some((r) => r.path === p)) return true
      if (childrenCache[p] !== undefined) return true
      const parent = dirname(p)
      const entry = childrenCache[parent]?.find((e) => e.path === p)
      return entry?.isDir ?? false
    },
    [repos, childrenCache],
  )

  // ----- actions ---------------------------------------------------------

  const openFile = useCallback(
    async (path: string) => {
      try {
        const result = await window.hive.fs.readFile(path)
        loadContent(path, result.contents)
        openTab(path)
        setActive(path)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Explorer: failed to read file', path, e)
      }
    },
    [loadContent, openTab, setActive],
  )

  /**
   * Expand `start`, then keep drilling through "passthrough" folders — ones
   * whose only entry is a single subdirectory — so deep single-child chains
   * (e.g. `com/example/app/...`) open in one click. Stops at the first folder
   * that holds a file, branches, or is empty. Children are fetched + cached
   * along the way (read fresh from the store so each step sees the previous
   * step's listing).
   */
  const expandWithDrill = useCallback(
    async (start: string) => {
      const MAX_DEPTH = 64
      let current = start
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        setExpanded(current, true)
        let entries = useWorkspaceStore.getState().childrenCache[current]
        if (entries === undefined) {
          try {
            entries = await window.hive.fs.listDir(current)
          } catch {
            return
          }
          cacheChildren(current, entries)
        }
        const next = nextDrillTarget(entries)
        if (next === null) return
        current = next
      }
    },
    [setExpanded, cacheChildren],
  )

  const toggleFolder = useCallback(
    (path: string) => {
      if (expandedSet.has(path)) {
        setExpanded(path, false)
        return
      }
      void expandWithDrill(path)
    },
    [expandedSet, setExpanded, expandWithDrill],
  )

  const refreshFolder = useCallback(
    (path: string) => {
      invalidateChildren(path)
      setExpanded(path, true)
    },
    [invalidateChildren, setExpanded],
  )

  const deletePath = useCallback(
    async (path: string, isDir: boolean) => {
      // Prevent accidental deletion of a top-level repo root.
      if (repos.some((r) => r.path === path)) {
        // eslint-disable-next-line no-console
        console.warn('Explorer: refusing to delete repo root', path)
        return
      }

      const tab = openTabs.find((t) => t.path === path)
      const isDirty = tab?.dirty || dirtyMap[path]
      if (isDirty) {
        const ok = window.confirm(
          `"${basename(path)}" has unsaved changes. Move to Trash anyway?`,
        )
        if (!ok) return
      } else if (isDir) {
        const ok = window.confirm(
          `Move folder "${basename(path)}" to Trash?`,
        )
        if (!ok) return
      }

      try {
        await window.hive.fs.trash(path)
        // Close any tab that lives under the deleted path.
        const sep = sepOf(path)
        const underPath = (p: string): boolean =>
          p === path || p.startsWith(path + sep)
        for (const t of openTabs) if (underPath(t.path)) closeTab(t.path)
        // Invalidate the parent so the explorer re-fetches its listing.
        invalidateChildren(dirname(path))
        if (selectedPath && underPath(selectedPath)) {
          setSelectedExplorerPath(null)
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Explorer: failed to trash', path, e)
      }
    },
    [
      repos,
      openTabs,
      dirtyMap,
      closeTab,
      invalidateChildren,
      selectedPath,
      setSelectedExplorerPath,
    ],
  )

  const commitRename = useCallback(
    async (oldPath: string, newName: string, _isDir: boolean) => {
      setPending(null)
      const trimmed = newName.trim()
      if (!trimmed || trimmed === basename(oldPath)) return
      // Reject path separators inside a rename — that's a move, not a rename.
      if (trimmed.includes('/') || trimmed.includes('\\')) {
        // eslint-disable-next-line no-console
        console.warn('Explorer: rename rejected (contains separator)', trimmed)
        return
      }
      const parent = dirname(oldPath)
      const newPath = joinPath(parent, trimmed)
      try {
        await window.hive.fs.rename(oldPath, newPath)
        renamePath(oldPath, newPath)
        invalidateChildren(parent)
        setSelectedExplorerPath(newPath)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Explorer: failed to rename', oldPath, '→', newPath, e)
      }
    },
    [renamePath, invalidateChildren, setSelectedExplorerPath],
  )

  const commitNew = useCallback(
    async (parentPath: string, name: string, kind: 'file' | 'folder') => {
      setPending(null)
      const trimmed = name.trim()
      if (!trimmed) return
      if (trimmed.includes('/') || trimmed.includes('\\')) {
        // eslint-disable-next-line no-console
        console.warn('Explorer: name rejected (contains separator)', trimmed)
        return
      }
      const newPath = joinPath(parentPath, trimmed)
      try {
        if (kind === 'folder') {
          await window.hive.fs.mkdir(newPath)
        } else {
          await window.hive.fs.writeFile(newPath, '')
        }
        invalidateChildren(parentPath)
        setExpanded(parentPath, true)
        setSelectedExplorerPath(newPath)
        if (kind === 'file') {
          // Defer one tick so the lazy-fetch effect can re-read the parent.
          window.setTimeout(() => {
            void openFile(newPath)
          }, 0)
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Explorer: failed to create', newPath, e)
      }
    },
    [invalidateChildren, setExpanded, setSelectedExplorerPath, openFile],
  )

  const revealInFinder = useCallback(async (path: string) => {
    try {
      await window.hive.fs.revealInFinder(path)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Explorer: failed to reveal', path, e)
    }
  }, [])

  const copyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Explorer: failed to copy path', path, e)
    }
  }, [])

  const collapseAll = useCallback(() => {
    for (const p of Array.from(expandedSet)) setExpanded(p, false)
  }, [expandedSet, setExpanded])

  const startNew = useCallback(
    (kind: 'new-file' | 'new-folder') => {
      const parent = selectedFolder
      if (!parent) return
      setExpanded(parent, true)
      setPending({ kind, parentPath: parent })
    },
    [selectedFolder, setExpanded],
  )

  // ----- context menu plumbing -------------------------------------------

  const onContextMenu = useCallback(
    (e: ReactMouseEvent, path: string, isDir: boolean, isRepoRoot: boolean) => {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        path,
        isDir,
        isRepoRoot,
      })
    },
    [],
  )

  const onContextAction = useCallback(
    async (action: ContextAction) => {
      const cm = contextMenu
      setContextMenu(null)
      if (!cm) return
      const parentForInsert = cm.isDir ? cm.path : dirname(cm.path)
      switch (action) {
        case 'new-file':
          setExpanded(parentForInsert, true)
          setPending({ kind: 'new-file', parentPath: parentForInsert })
          break
        case 'new-folder':
          setExpanded(parentForInsert, true)
          setPending({ kind: 'new-folder', parentPath: parentForInsert })
          break
        case 'rename':
          if (cm.isRepoRoot) return
          setPending({ kind: 'rename', path: cm.path, isDir: cm.isDir })
          break
        case 'delete':
          if (cm.isRepoRoot) return
          await deletePath(cm.path, cm.isDir)
          break
        case 'refresh':
          refreshFolder(cm.isDir ? cm.path : dirname(cm.path))
          break
        case 'reveal':
          await revealInFinder(cm.path)
          break
        case 'copy-path':
          await copyPath(cm.path)
          break
      }
    },
    [contextMenu, setExpanded, deletePath, refreshFolder, revealInFinder, copyPath],
  )

  // ----- keyboard shortcuts ----------------------------------------------
  //
  // Only fire when the explorer DOM owns focus AND no inline input is open
  // (the input swallows its own keys). The handler is registered at window
  // scope so we don't lose key events when focus drifts into a child row.

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const root = explorerRef.current
      if (!root) return
      const target = event.target instanceof Node ? event.target : null
      if (!target || !root.contains(target)) return
      if (pending) return

      const mod = event.metaKey || event.ctrlKey
      const k = event.key.toLowerCase()

      if (mod && k === 'n') {
        event.preventDefault()
        startNew(event.shiftKey ? 'new-folder' : 'new-file')
        return
      }
      if (mod && k === 'r') {
        event.preventDefault()
        if (selectedFolder) refreshFolder(selectedFolder)
        return
      }
      if (event.key === 'Enter' && !mod) {
        if (!selectedPath) return
        if (repos.some((r) => r.path === selectedPath)) return
        event.preventDefault()
        setPending({
          kind: 'rename',
          path: selectedPath,
          isDir: isPathDir(selectedPath),
        })
        return
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !mod) {
        if (!selectedPath) return
        if (repos.some((r) => r.path === selectedPath)) return
        event.preventDefault()
        void deletePath(selectedPath, isPathDir(selectedPath))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    pending,
    selectedFolder,
    selectedPath,
    repos,
    refreshFolder,
    deletePath,
    startNew,
    isPathDir,
  ])

  // ----- render ----------------------------------------------------------

  if (!project) return <EmptyExplorer />

  return (
    <aside
      className="explorer"
      ref={(el) => {
        explorerRef.current = el
      }}
      tabIndex={0}
      onClick={() => {
        // Click on empty area clears selection so the next ⌘N targets the
        // first repo (the documented fallback).
      }}
    >
      <div className="exp-head">
        <span className="ttl">Explorer</span>
        <div className="exp-actions">
          <button
            className="ib"
            title="New File (⌘N)"
            type="button"
            onClick={() => startNew('new-file')}
          >
            <Icon name="file-plus" />
          </button>
          <button
            className="ib"
            title="New Folder (⌘⇧N)"
            type="button"
            onClick={() => startNew('new-folder')}
          >
            <Icon name="folder-plus" />
          </button>
          <button
            className="ib"
            title="Refresh (⌘R)"
            type="button"
            onClick={() => selectedFolder && refreshFolder(selectedFolder)}
          >
            <Icon name="refresh-cw" />
          </button>
          <button
            className="ib"
            title="Collapse all"
            type="button"
            onClick={collapseAll}
          >
            <Icon name="chevrons-down-up" />
          </button>
        </div>
      </div>

      <div className="exp-repo">
        <Icon name="folder" size={14} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {project.name}
        </span>
        <span
          style={{
            font: 'var(--t-meta)',
            color: 'var(--fg-3)',
          }}
        >
          {repos.length} repo{repos.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="tree">
        {repos.length === 0 && (
          <div
            className="row"
            style={{ paddingLeft: 8, color: 'var(--fg-3)', cursor: 'default' }}
            title="No repos detected in this folder"
          >
            <span className="nm">No repos found</span>
          </div>
        )}
        {repos.map((repo: Repo) => (
          <FolderRow
            key={repo.path}
            name={repo.name}
            path={repo.path}
            isRepoRoot
            depth={0}
            selectedPath={selectedPath}
            expandedSet={expandedSet}
            childrenCache={childrenCache}
            pending={pending}
            onSelect={setSelectedExplorerPath}
            onToggle={toggleFolder}
            onOpenFile={openFile}
            onContextMenu={onContextMenu}
            onCommitNew={commitNew}
            onCommitRename={commitRename}
            onCancelPending={() => setPending(null)}
          />
        ))}
      </div>

      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onAction={onContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}
    </aside>
  )
}
