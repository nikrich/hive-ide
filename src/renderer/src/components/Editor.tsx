/**
 * Hive IDE — store-driven tabbed editor (STORY-024).
 *
 * This is the moment the editor surface becomes real. The previous
 * textarea+highlight `CodeEditor` and the read-only streaming `AgentEditor`
 * are gone; in their place we mount {@link MonacoEditor} (STORY-023) over
 * the Zustand workspace store (STORY-021).
 *
 * Architectural notes
 * -------------------
 * - **No tab props.** `openTabs`, `activeTabPath`, `dirtyMap`, `contentsCache`,
 *   and per-tab Monaco view-state are read straight from the store. Writes
 *   go back via store actions; the App shell stops threading any of this
 *   state through.
 * - **Save bound inside Monaco.** ⌘S / Ctrl+S inside the editor calls
 *   `window.hive.fs.writeFile` and then clears the tab's dirty flag. Any
 *   global ⌘S handler in App.tsx is now redundant — it can be removed
 *   when the App rewire lands in STORY-028.
 * - **Tab labels disambiguate by repo.** When open tabs span more than one
 *   repo each tab shows `repoName / relativePath`; when every tab lives in
 *   a single repo (or in no repo at all) tabs collapse to the bare
 *   filename. Long labels get mid-ellipsised — see `lib/tabLabel.ts`.
 * - **TabBar + Breadcrumb markup preserved.** The story requires the
 *   visual shells from STORY-008 to land here unchanged, so the class
 *   names (`tabbar`, `tab`, `tnm`, `dirty`, `x`, `breadcrumb`, `seg`) are
 *   exactly the ones the existing CSS targets.
 * - **Per-tab MonacoEditor remount.** Switching tabs changes the React
 *   `key`, which forces a clean unmount of the previous Monaco instance.
 *   The unmount path snapshots view-state into the OLD tab's slot via the
 *   closure that was captured at render time — see the comment on
 *   `bindOnViewStateChange` below.
 *
 * No `any`. Monaco's `ICodeEditorViewState` is `unknown` in the shared
 * workspace types; the cast at the edge here is the only place we narrow
 * to Monaco's concrete type.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { editor as MonacoNs } from 'monaco-editor'

import MonacoEditor from './MonacoEditor'
import DiffView from './DiffView'
import ExternalChangeBanner from './ExternalChangeBanner'
import Toast from './Toast'
import { Icon, fileIcon } from './primitives'
import { ContextMenu } from './primitives/ContextMenu'
import { useWorkspaceStore } from '../store/workspaceStore'
import {
  basename,
  reposWithOpenTabs,
  sepOf,
  tabLabel,
} from '../lib/tabLabel'
import { classifyFsChange } from '../lib/externalChange'
import { languageForPath } from '../lib/languageForPath'
import { getActiveEditor } from '../lib/activeEditor'
import { useEditorCommands } from '../lib/useEditorCommands'
import { useSettingsStore } from '../store/settingsStore'
import { useCommandStore } from '../store/commandStore'
import type { EditorViewState, OpenTab, Repo } from '../../../types/workspace'
import type { FsChangeEvent } from '../../../preload/api'

/**
 * Ensure the model ends with exactly one trailing newline (E1-14). Applied as
 * a model edit so it participates in undo and doesn't disturb the cursor.
 */
function ensureFinalNewline(ed: MonacoNs.IStandaloneCodeEditor): void {
  const model = ed.getModel()
  if (model === null) return
  const lineCount = model.getLineCount()
  // A trailing empty line means the file already ends in a newline.
  if (model.getLineLength(lineCount) === 0) return
  const col = model.getLineMaxColumn(lineCount)
  model.applyEdits([
    {
      range: {
        startLineNumber: lineCount,
        startColumn: col,
        endLineNumber: lineCount,
        endColumn: col,
      },
      text: '\n',
    },
  ])
}

// ---------------------------------------------------------------------------
// TabBar
// ---------------------------------------------------------------------------

interface TabBarProps {
  tabs: readonly OpenTab[]
  active: string | null
  dirtyMap: Readonly<Record<string, boolean>>
  repos: readonly Repo[]
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

function TabBar({ tabs, active, dirtyMap, repos, onSelect, onClose }: TabBarProps) {
  // Set of repo paths with at least one open tab — the disambiguation key.
  // Memoised so every row's `tabLabel` call sees the same Set reference.
  const reposWithTabs = useMemo(
    () => reposWithOpenTabs(tabs.map((t) => t.path), repos),
    [tabs, repos],
  )

  const closeOtherTabs = useWorkspaceStore((s) => s.closeOtherTabs)
  const closeTabsToRight = useWorkspaceStore((s) => s.closeTabsToRight)
  const closeSavedTabs = useWorkspaceStore((s) => s.closeSavedTabs)
  const reopenClosedTab = useWorkspaceStore((s) => s.reopenClosedTab)
  const openInSecondary = useWorkspaceStore((s) => s.openInSecondary)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(
    null,
  )

  return (
    <div className="tabbar">
      {tabs.map((tab) => {
        const path = tab.path
        // Diff tabs synthesise their own label + use a git icon so they
        // visually separate from real files in the bar.
        const isDiff = tab.diffMeta !== undefined
        const file = isDiff && tab.diffMeta
          ? basename(tab.diffMeta.path)
          : basename(path)
        const [defaultIconName, tint] = fileIcon(file)
        const iconName = isDiff ? 'git-compare' : defaultIconName
        const label = isDiff && tab.diffMeta
          ? tab.diffMeta.label
          : tabLabel(path, repos, reposWithTabs)
        const isDirty = Boolean(dirtyMap[path])
        const isActive = path === active

        const closeHandler = (event: ReactMouseEvent<HTMLSpanElement>) => {
          event.stopPropagation()
          onClose(path)
        }

        return (
          <div
            key={path}
            className={'tab' + (isActive ? ' active' : '')}
            onClick={() => onSelect(path)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, path })
            }}
            title={path}
          >
            <span className={'fi ' + tint}>
              <Icon name={iconName} size={14} />
            </span>
            <span className="tnm">{label}</span>
            {isDirty ? (
              <span
                className="dirty"
                onClick={closeHandler}
                title="Unsaved changes — click to close"
              />
            ) : (
              <span className="x" onClick={closeHandler} title="Close tab">
                <Icon name="x" size={13} />
              </span>
            )}
          </div>
        )
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Close', onSelect: () => onClose(menu.path) },
            {
              label: 'Open to the Side',
              onSelect: () => openInSecondary(menu.path),
            },
            {
              label: 'Close Others',
              onSelect: () => closeOtherTabs(menu.path),
            },
            {
              label: 'Close to the Right',
              onSelect: () => closeTabsToRight(menu.path),
            },
            { label: 'Close Saved', onSelect: () => closeSavedTabs() },
            { label: 'Reopen Closed Editor', onSelect: () => reopenClosedTab() },
          ]}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

interface BreadcrumbProps {
  path: string
  /** Absolute paths of the active project's repos — used to relativize the breadcrumb. */
  repos: readonly Repo[]
  dirty?: boolean
}

/**
 * Strip the active repo's root path from `path` and return the owning repo's name
 * plus the remaining segments. Falls back to the full absolute path when no repo
 * contains it (rare — only happens if the user navigates outside the tree).
 */
function relativizeToRepo(path: string, repos: readonly Repo[]): { repoName: string | null; segments: string[] } {
  const sep = sepOf(path)
  // Sort longer paths first so nested-repo cases pick the deepest match.
  const sorted = [...repos].sort((a, b) => b.path.length - a.path.length)
  for (const r of sorted) {
    const prefix = r.path.endsWith(sep) ? r.path : r.path + sep
    if (path.startsWith(prefix)) {
      return { repoName: r.name, segments: path.slice(prefix.length).split(sep).filter(Boolean) }
    }
    if (path === r.path) {
      return { repoName: r.name, segments: [] }
    }
  }
  return { repoName: null, segments: path.split(sep).filter(Boolean) }
}

function Breadcrumb({ path, repos, dirty }: BreadcrumbProps) {
  const { repoName, segments } = relativizeToRepo(path, repos)
  // The repo name is rendered as the first segment when present; otherwise we
  // show the absolute path (last-resort).
  const display = repoName ? [repoName, ...segments] : segments
  return (
    <div className="breadcrumb" title={path}>
      <Icon name="folder" size={13} />
      {display.map((seg, i) => (
        // eslint-disable-next-line react/no-array-index-key -- segments are positional
        <span key={i} className="seg-wrap">
          {i > 0 && <Icon name="chevron-right" size={13} />}
          <span className={'seg' + (i === display.length - 1 ? ' last' : '')}>{seg}</span>
        </span>
      ))}
      {dirty && <span className="bc-dirty">● unsaved</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// EmptyEditor
// ---------------------------------------------------------------------------

function EmptyEditor() {
  return (
    <div className="editor-empty">
      <img src="./hive-mark.png" alt="" />
      <div style={{ font: 'var(--t-h3)', color: 'var(--fg-2)' }}>No file open</div>
      <div className="hint">
        Open a file from the explorer, or press <span className="kbd">⌘K</span> to jump
        anywhere.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EditorGroup — the public composite
// ---------------------------------------------------------------------------

export interface EditorGroupProps {
  /** Which editor group this instance renders (E5-01). Defaults to primary. */
  group?: 'primary' | 'secondary'
}

export function EditorGroup({ group = 'primary' }: EditorGroupProps = {}) {
  const isPrimary = group === 'primary'

  // Singleton concerns (commands, fs-change subscription) run only for the
  // primary group so a second group doesn't double-register or double-handle.
  useEditorCommands(isPrimary)
  useTabCommands(isPrimary)

  // ----- state from the store --------------------------------------------
  const primaryTabs = useWorkspaceStore((s) => s.openTabs)
  const secondaryTabs = useWorkspaceStore((s) => s.secondaryTabs)
  const primaryActive = useWorkspaceStore((s) => s.activeTabPath)
  const secondaryActive = useWorkspaceStore((s) => s.secondaryActiveTabPath)
  const openTabs = isPrimary ? primaryTabs : secondaryTabs
  const activeTabPath = isPrimary ? primaryActive : secondaryActive
  const dirtyMap = useWorkspaceStore((s) => s.dirtyMap)
  const contentsCache = useWorkspaceStore((s) => s.contentsCache)
  const repos = useWorkspaceStore((s) => s.repos)
  const setActiveGroup = useWorkspaceStore((s) => s.setActiveGroup)

  // ----- store actions (group-aware) -------------------------------------
  const setActivePrimary = useWorkspaceStore((s) => s.setActive)
  const setActiveSecondary = useWorkspaceStore((s) => s.setSecondaryActive)
  const closeTabPrimary = useWorkspaceStore((s) => s.closeTab)
  const closeTabSecondary = useWorkspaceStore((s) => s.closeSecondaryTab)
  const setActive = isPrimary ? setActivePrimary : setActiveSecondary
  const closeTab = isPrimary ? closeTabPrimary : closeTabSecondary
  const updateContent = useWorkspaceStore((s) => s.updateContent)
  const markDirty = useWorkspaceStore((s) => s.markDirty)
  const loadContent = useWorkspaceStore((s) => s.loadContent)
  const setViewState = useWorkspaceStore((s) => s.setViewState)
  const invalidateChildren = useWorkspaceStore((s) => s.invalidateChildren)

  // ----- external-change banner + toast ---------------------------------
  //
  // The banner is shown when the active tab is *dirty* and its file was
  // modified on disk. `pendingExternalChange` is keyed by absolute path so
  // switching tabs naturally drops the banner — the banner only renders
  // when its path matches `activeTabPath`.
  //
  // The toast carries a single string message; we render at most one at a
  // time and let the new one replace any in-flight timer.
  const [pendingExternalChange, setPendingExternalChange] = useState<{
    path: string
  } | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  // ----- derive the active tab + its content -----------------------------
  const activeTab = useMemo<OpenTab | null>(() => {
    if (!activeTabPath) return null
    return openTabs.find((t) => t.path === activeTabPath) ?? null
  }, [activeTabPath, openTabs])

  const activeValue = activeTabPath ? contentsCache[activeTabPath] ?? '' : ''

  // ----- lazy content load for the active tab ----------------------------
  //
  // A tab can be active WITHOUT its content in `contentsCache`: switching
  // projects clears the cache (setProject), and restoring a session on boot /
  // re-entry rehydrates `openTabs` + `activeTabPath` but NOT content (content
  // isn't persisted). Explorer-click opens read the file eagerly, but a
  // *restored* active tab has nothing — Monaco would render `''` (the blank
  // editor the user saw after switching projects and coming back). So if the
  // active tab is a real file (not a diff) and its content is missing, read
  // it on disk and populate the cache. Re-runs harmlessly once the value is
  // present (the early-return below).
  useEffect(() => {
    const path = activeTabPath
    if (!path) return
    if (activeTab?.diffMeta) return // diff tabs supply their own content
    if (contentsCache[path] !== undefined) return
    const bridge = window.hive
    if (!bridge || typeof bridge.fs?.readFile !== 'function') return

    let cancelled = false
    void bridge.fs
      .readFile(path)
      .then((result) => {
        if (cancelled) return
        loadContent(path, result.contents)
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('Editor: failed to load active tab content', path, e)
      })
    return () => {
      cancelled = true
    }
  }, [activeTabPath, activeTab?.diffMeta, contentsCache, loadContent])

  // ----- handlers --------------------------------------------------------
  //
  // onChange / onSave / onViewStateChange all close over `activeTabPath`.
  // When the user switches tabs, the parent re-renders with a different
  // closure AND a different React `key` on MonacoEditor. The old Monaco
  // instance is unmounted, its cleanup effect snapshots view-state through
  // the closure it captured at *its* render time — which still points at
  // the old path. The new instance receives the new closures. This avoids
  // the classic "save the old viewState into the new tab's slot" bug.

  const onChange = useCallback(
    (next: string) => {
      if (!activeTabPath) return
      updateContent(activeTabPath, next)
    },
    [activeTabPath, updateContent],
  )

  const onSave = useCallback(async () => {
    const path = activeTabPath
    if (!path) return

    // Apply on-save transforms (E1-14, E4-09) against the focused editor's
    // model so the saved bytes match what subsequent reads see.
    const ed = getActiveEditor()
    const settings = useSettingsStore.getState().settings
    if (ed) {
      if (settings['editor.formatOnSave']) {
        try {
          await ed.getAction('editor.action.formatDocument')?.run()
        } catch {
          // Formatting failures must not block a save.
        }
      }
      if (settings['editor.trimTrailingWhitespace']) {
        ed.getAction('editor.action.trimTrailingWhitespace')?.run()
      }
      if (settings['editor.insertFinalNewline']) {
        ensureFinalNewline(ed)
      }
    }

    // Prefer the live model value (it reflects any transform above); fall back
    // to the cache for diff/edge cases where no editor is focused.
    const contents = ed?.getModel()?.getValue() ?? contentsCache[path]
    if (contents === undefined) return
    try {
      await window.hive.fs.writeFile(path, contents)
      // On-disk now matches in-memory. Refresh the cache (keeps the canonical
      // value in sync after any transform) and clear the dirty flag.
      loadContent(path, contents)
      markDirty(path, false)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Editor: failed to save', path, e)
    }
  }, [activeTabPath, contentsCache, loadContent, markDirty])

  const onViewStateChange = useCallback(
    (state: MonacoNs.ICodeEditorViewState) => {
      if (!activeTabPath) return
      // The store treats viewState as opaque `unknown` (EditorViewState);
      // pass Monaco's value straight through.
      setViewState(activeTabPath, state as EditorViewState)
    },
    [activeTabPath, setViewState],
  )

  // ----- silent reload (the no-banner branch) ----------------------------
  //
  // Used both directly (clean buffer changed on disk) and from the banner's
  // Reload button (dirty buffer, user accepted the disk version). Re-reads
  // the file, replaces the in-memory cache, clears dirty. The Monaco
  // editor for the active tab picks up the new value via its `value` prop.
  const reloadFromDisk = useCallback(
    async (path: string): Promise<void> => {
      try {
        const result = await window.hive.fs.readFile(path)
        loadContent(path, result.contents)
        markDirty(path, false)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Editor: failed to reload from disk', path, e)
      }
    },
    [loadContent, markDirty],
  )

  // ----- fs-change subscription ------------------------------------------
  //
  // The subscription must NOT re-run every time the store changes — chokidar
  // events are high-frequency under heavy git operations and resubscribing
  // would tear/restore the channel each time. Instead we hold the latest
  // state in refs and dispatch through them. The effect runs once per mount
  // and the cleanup unsubscribes from the preload bridge.

  const openPathsRef = useRef<Set<string>>(new Set())
  const dirtyMapRef = useRef<Readonly<Record<string, boolean>>>(dirtyMap)
  const reloadRef = useRef(reloadFromDisk)
  const closeTabRef = useRef(closeTab)
  const invalidateChildrenRef = useRef(invalidateChildren)

  useEffect(() => {
    openPathsRef.current = new Set(openTabs.map((t) => t.path))
  }, [openTabs])
  useEffect(() => {
    dirtyMapRef.current = dirtyMap
  }, [dirtyMap])
  useEffect(() => {
    reloadRef.current = reloadFromDisk
  }, [reloadFromDisk])
  useEffect(() => {
    closeTabRef.current = closeTab
  }, [closeTab])
  useEffect(() => {
    invalidateChildrenRef.current = invalidateChildren
  }, [invalidateChildren])

  useEffect(() => {
    // Only the primary group owns the fs-change pipeline (reload banners,
    // external-change handling) so a split doesn't double-handle events.
    if (!isPrimary) return
    // `window.hive` is injected by the preload script. In test / Storybook
    // contexts it may be absent; bail out cleanly so the editor still mounts.
    const bridge = window.hive
    if (!bridge || typeof bridge.onFsChange !== 'function') return

    const handler = (event: FsChangeEvent): void => {
      const path = event.path
      const isOpenTab = openPathsRef.current.has(path)
      const isDirty = Boolean(dirtyMapRef.current[path])
      const intent = classifyFsChange(event, { isOpenTab, isDirty })

      switch (intent.kind) {
        case 'silent-reload':
          // Clean buffer + on-disk change → re-read, no banner. Any banner
          // that was already up referred to an earlier dirty state for the
          // same path; reloading also clears the dirty flag, so we drop it.
          setPendingExternalChange((cur) =>
            cur && cur.path === intent.path ? null : cur,
          )
          void reloadRef.current(intent.path)
          return
        case 'show-banner':
          setPendingExternalChange({ path: intent.path })
          return
        case 'close-with-toast':
          closeTabRef.current(intent.path)
          setPendingExternalChange((cur) =>
            cur && cur.path === intent.path ? null : cur,
          )
          setToastMessage(`'${intent.path}' was deleted on disk`)
          return
        case 'refresh-parent':
          invalidateChildrenRef.current(intent.parent)
          return
        case 'ignore':
          return
      }
    }

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = bridge.onFsChange(handler)
    } catch (e) {
      // The preload stub throws "not implemented" until the IPC channel is
      // wired up. That's expected during the in-flight REQ-002 stories —
      // log once and continue without blowing up the editor.
      // eslint-disable-next-line no-console
      console.warn('Editor: onFsChange unavailable', e)
      return
    }

    return () => {
      if (unsubscribe) {
        try {
          unsubscribe()
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('Editor: onFsChange unsubscribe failed', e)
        }
      }
    }
  }, [])

  // ----- banner handlers -------------------------------------------------

  const onBannerReload = useCallback(async () => {
    const path = pendingExternalChange?.path
    if (!path) return
    await reloadFromDisk(path)
    setPendingExternalChange(null)
  }, [pendingExternalChange, reloadFromDisk])

  const onBannerKeep = useCallback(() => {
    // "Keep yours" leaves the in-memory buffer untouched and the tab dirty.
    // Just dismiss the banner.
    setPendingExternalChange(null)
  }, [])

  const onToastDismiss = useCallback(() => {
    setToastMessage(null)
  }, [])

  // REQ-007: LSP startup may run a `setup.downloads` step the first
  // time a plugin's server is needed (jdtls is ~80 MB and downloads on
  // demand). `lspClient` dispatches `hive:lsp-progress` CustomEvents
  // with `{ pluginId, message }` payloads while that's in flight; we
  // surface them via the existing toast.
  useEffect(() => {
    const listener = (e: Event): void => {
      const ce = e as CustomEvent<{ pluginId: string; message: string }>
      const detail = ce.detail
      if (detail === undefined || detail === null) return
      setToastMessage(detail.message)
    }
    window.addEventListener('hive:lsp-progress', listener)
    return () => window.removeEventListener('hive:lsp-progress', listener)
  }, [])

  // ----- render ----------------------------------------------------------

  const showEmpty = openTabs.length === 0 || activeTabPath === null

  // The banner only renders when its path is also the active tab — switching
  // tabs while a banner is pending hides it without dismissing the pending
  // state, so switching back brings it back. (Tab close clears it via the
  // dedicated `close-with-toast` branch above.)
  const showBanner =
    pendingExternalChange !== null &&
    activeTabPath !== null &&
    pendingExternalChange.path === activeTabPath

  return (
    <section
      className="editor"
      data-group={group}
      onMouseDown={() => setActiveGroup(group)}
    >
      <TabBar
        tabs={openTabs}
        active={activeTabPath}
        dirtyMap={dirtyMap}
        repos={repos}
        onSelect={setActive}
        onClose={closeTab}
      />
      {showEmpty ? (
        <EmptyEditor />
      ) : activeTab?.diffMeta ? (
        // REQ-008 — diff tabs delegate to a self-contained host that
        // fetches its own LHS / RHS via the git bridge. Forced remount
        // on tab switch via `key` so prior diffs don't bleed through.
        <DiffTabHost key={activeTabPath} meta={activeTab.diffMeta} />
      ) : (
        <>
          {showBanner && (
            <ExternalChangeBanner
              path={pendingExternalChange.path}
              onReload={onBannerReload}
              onKeep={onBannerKeep}
            />
          )}
          <Breadcrumb
            path={activeTabPath}
            repos={repos}
            dirty={Boolean(dirtyMap[activeTabPath])}
          />
          <MonacoEditor
            // Force a clean remount on tab switch so view-state restore
            // always targets a fresh Monaco model. See the closure note
            // above the handler block.
            key={activeTabPath}
            path={activeTabPath}
            value={activeValue}
            onChange={onChange}
            onSave={onSave}
            viewState={
              (activeTab?.viewState ?? undefined) as
                | MonacoNs.ICodeEditorViewState
                | undefined
            }
            onViewStateChange={onViewStateChange}
          />
        </>
      )}
      {toastMessage !== null && (
        <Toast message={toastMessage} onDismiss={onToastDismiss} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// DiffTabHost — REQ-008 diff renderer
// ---------------------------------------------------------------------------
//
// A diff tab carries a `diffMeta` payload but no in-memory content. This host
// resolves the two sides on mount via the git bridge + the filesystem and
// hands them to Monaco's DiffEditor.
//
//   ref='head'  → LHS = HEAD@path,  RHS = working-tree contents (fs.readFile)
//   ref='index' → LHS = HEAD@path,  RHS = index@path
//
// Untracked files are treated as the LHS-empty case ('show' returns '' when
// the object doesn't exist in HEAD).

interface DiffTabHostProps {
  meta: NonNullable<OpenTab['diffMeta']>
}

function DiffTabHost({ meta }: DiffTabHostProps) {
  const [original, setOriginal] = useState<string | null>(null)
  const [modified, setModified] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Absolute path of the file on disk — used both for fs.readFile and for
  // language detection. The repo path uses the platform's native separator
  // but porcelain paths are always `/`; join with `/` and trust the OS to
  // normalise it.
  const absPath = useMemo(() => {
    const sep = meta.repoPath.includes('\\') ? '\\' : '/'
    const trimmed = meta.repoPath.endsWith(sep)
      ? meta.repoPath.slice(0, -1)
      : meta.repoPath
    return `${trimmed}${sep}${meta.path}`
  }, [meta.repoPath, meta.path])

  useEffect(() => {
    let cancelled = false
    setOriginal(null)
    setModified(null)
    setError(null)

    async function load(): Promise<void> {
      try {
        const leftPromise = window.hive.git.fileShow(
          meta.repoPath,
          meta.path,
          'head',
        )
        const rightPromise =
          meta.ref === 'index'
            ? window.hive.git.fileShow(meta.repoPath, meta.path, 'index')
            : window.hive.fs
                .readFile(absPath)
                .then((r) => r.contents)
                .catch(() => '')
        const [left, right] = await Promise.all([leftPromise, rightPromise])
        if (cancelled) return
        setOriginal(left)
        setModified(right)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [absPath, meta.path, meta.ref, meta.repoPath])

  if (error !== null) {
    return (
      <div className="editor-empty">
        <div style={{ font: 'var(--t-h3)', color: 'var(--fg-2)' }}>
          Diff unavailable
        </div>
        <div className="hint">{error}</div>
      </div>
    )
  }
  if (original === null || modified === null) {
    return <div className="monaco-loading" aria-busy="true" />
  }
  return (
    <DiffView
      original={original}
      modified={modified}
      language={languageForPath(meta.path, {})}
    />
  )
}

// ---------------------------------------------------------------------------
// Tab-management commands (E5-07)
// ---------------------------------------------------------------------------

/**
 * Register editor-tab commands (close active/others/right/saved, reopen
 * closed) against the workspace store. Handlers read the active path at call
 * time via getState so they don't need to re-register on every tab change.
 */
function useTabCommands(enabled = true): void {
  const register = useCommandStore((s) => s.register)
  useEffect(() => {
    if (!enabled) return
    const store = useWorkspaceStore
    const active = (): string | null => store.getState().activeTabPath
    const defs = [
      {
        id: 'workbench.action.closeActiveEditor',
        title: 'Close Editor',
        category: 'View',
        handler: () => {
          const p = active()
          if (p) store.getState().closeTab(p)
        },
      },
      {
        id: 'workbench.action.closeOtherEditors',
        title: 'Close Other Editors',
        category: 'View',
        handler: () => {
          const p = active()
          if (p) store.getState().closeOtherTabs(p)
        },
      },
      {
        id: 'workbench.action.closeEditorsToTheRight',
        title: 'Close Editors to the Right',
        category: 'View',
        handler: () => {
          const p = active()
          if (p) store.getState().closeTabsToRight(p)
        },
      },
      {
        id: 'workbench.action.closeSavedEditors',
        title: 'Close Saved Editors',
        category: 'View',
        handler: () => store.getState().closeSavedTabs(),
      },
      {
        id: 'workbench.action.reopenClosedEditor',
        title: 'Reopen Closed Editor',
        category: 'View',
        handler: () => store.getState().reopenClosedTab(),
      },
      {
        id: 'workbench.action.splitEditor',
        title: 'Split Editor',
        category: 'View',
        handler: () => {
          const p = active()
          if (p) store.getState().openInSecondary(p)
        },
      },
      {
        id: 'workbench.action.focusFirstEditorGroup',
        title: 'Focus First Editor Group',
        category: 'View',
        handler: () => store.getState().setActiveGroup('primary'),
      },
      {
        id: 'workbench.action.focusSecondEditorGroup',
        title: 'Focus Second Editor Group',
        category: 'View',
        handler: () => store.getState().setActiveGroup('secondary'),
      },
    ]
    const disposers = defs.map((d) => register(d))
    return () => disposers.forEach((dispose) => dispose())
  }, [register, enabled])
}

// Re-exports kept for tests / future composition.
export { TabBar, Breadcrumb, EmptyEditor, DiffTabHost }
