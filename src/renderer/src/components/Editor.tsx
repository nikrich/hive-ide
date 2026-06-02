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
import ExternalChangeBanner from './ExternalChangeBanner'
import Toast from './Toast'
import { Icon, fileIcon } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'
import {
  basename,
  reposWithOpenTabs,
  sepOf,
  tabLabel,
} from '../lib/tabLabel'
import { classifyFsChange } from '../lib/externalChange'
import type { EditorViewState, OpenTab, Repo } from '../../../types/workspace'
import type { FsChangeEvent } from '../../../preload/api'

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

  return (
    <div className="tabbar">
      {tabs.map((tab) => {
        const path = tab.path
        const file = basename(path)
        const [iconName, tint] = fileIcon(file)
        const label = tabLabel(path, repos, reposWithTabs)
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

interface BreadcrumbProps {
  path: string
  dirty?: boolean
}

function Breadcrumb({ path, dirty }: BreadcrumbProps) {
  const sep = sepOf(path)
  // `filter(Boolean)` drops the empty leading segment from absolute POSIX
  // paths (`/usr/bin/node` → ['', 'usr', 'bin', 'node'] → ['usr', 'bin', 'node']).
  const segs = path.split(sep).filter(Boolean)
  return (
    <div className="breadcrumb">
      <Icon name="folder" size={13} />
      {segs.map((seg, i) => (
        // eslint-disable-next-line react/no-array-index-key -- segments are positional
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {i > 0 && <Icon name="chevron-right" size={13} />}
          <span className={'seg' + (i === segs.length - 1 ? ' last' : '')}>{seg}</span>
        </span>
      ))}
      {dirty && (
        <span style={{ marginLeft: 8, color: 'var(--fg-3)', font: 'var(--t-meta)' }}>
          ● unsaved
        </span>
      )}
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

export function EditorGroup() {
  // ----- state from the store --------------------------------------------
  const openTabs = useWorkspaceStore((s) => s.openTabs)
  const activeTabPath = useWorkspaceStore((s) => s.activeTabPath)
  const dirtyMap = useWorkspaceStore((s) => s.dirtyMap)
  const contentsCache = useWorkspaceStore((s) => s.contentsCache)
  const repos = useWorkspaceStore((s) => s.repos)

  // ----- store actions ---------------------------------------------------
  const setActive = useWorkspaceStore((s) => s.setActive)
  const closeTab = useWorkspaceStore((s) => s.closeTab)
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
    const contents = contentsCache[path]
    if (contents === undefined) return
    try {
      await window.hive.fs.writeFile(path, contents)
      // On-disk now matches in-memory. Refresh the cache (no-op for the
      // common case, but keeps the canonical value in sync after any
      // normalisation the writer might do) and clear the dirty flag.
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
    <section className="editor">
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

// Re-exports kept for tests / future composition.
export { TabBar, Breadcrumb, EmptyEditor }
