/**
 * Renderer Zustand workspace store — the single source of truth for the IDE.
 *
 * This is the fanout point every other renderer story consumes
 * (Editor, Explorer, Welcome, App shell, banners, ribbons). The exported
 * actions + state shape are the contract those stories build against.
 *
 * REQ-003 redirected the project model: a project is now a user-created
 * named container that the user adds folders (repos) to one at a time.
 * The store grew matching lifecycle actions (`createProject`,
 * `addRepoToProject`, `removeRepoFromProject`, `renameProject`,
 * `closeProject`) and lost `openProject` (which used to swap in a
 * detection-result Project).
 *
 * Rules:
 * - **Selective IPC inside the store.** `addRepoToProject` reaches across
 *   the preload bridge to `inspectFolder` so the caller doesn't have to.
 *   The store stays the single place that knows how to grow a project.
 * - **Type-only imports across process boundaries.** Nothing here imports
 *   anything from `main` / `preload` at runtime except `window.hive`, which
 *   is set by the preload script.
 * - **Strongly typed.** No `any`. `unknown` (e.g. `EditorViewState`)
 *   appears where a downstream consumer narrows.
 */

import { create } from 'zustand'

import type {
  DirEntry,
  EditorViewState,
  GitStatusEntry,
  LayoutSnapshot,
  LoadedPlugin,
  OpenTab,
  PanelTerminalTab,
  Project,
  ProjectSessionSnapshot,
  RecentEntry,
  Repo,
  TerminalsSnapshot,
  TermSessionSnapshot,
} from '../../../types/workspace'

import { pushRecent as pushRecentLRU } from './recents'

/** Top-level views the workarea routes between (mirrors App.tsx ViewKey). */
export type WorkspaceView = 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term'
/** Bottom-panel tab (mirrors BottomPanel.tsx BottomPanelTab). */
export type WorkspacePanelTab = 'terminal' | 'log' | 'problems'

/**
 * Detect the path separator a given absolute path is using. We can't read
 * `window.hive.platform` here because the store is the one place we
 * deliberately stay free of preload coupling — so we sniff it off the
 * payload instead. Backslashes only appear on Windows absolute paths.
 */
function pathSep(p: string): '\\' | '/' {
  return p.includes('\\') ? '\\' : '/'
}

/**
 * Rewrite `oldPath` to `newPath`, including any path that is *under* the
 * renamed entry (e.g. renaming `/a/foo` should rewrite `/a/foo/bar.ts` to
 * `/a/foo-renamed/bar.ts`). All other paths are returned untouched.
 */
function rewritePath(p: string, oldPath: string, newPath: string): string {
  if (p === oldPath) return newPath
  const sep = pathSep(oldPath)
  const prefix = oldPath.endsWith(sep) ? oldPath : oldPath + sep
  if (p.startsWith(prefix)) return newPath + p.slice(oldPath.length)
  return p
}

/** Build a RecentEntry from a Project. */
function recentFromProject(p: Project): RecentEntry {
  return {
    id: p.id,
    name: p.name,
    repoCount: p.repos.length,
    lastOpenedAt: p.lastOpenedAt,
  }
}

/**
 * Generate a stable id for a freshly-created project. Wrapped so tests can
 * swap it; production uses the Web Crypto API exposed in both Electron and
 * happy-dom.
 *
 * Falls back to a timestamp-based id if `crypto.randomUUID` is unavailable —
 * vitest's happy-dom has it, but the Node test runner used by `main` does
 * not (and these store tests run in happy-dom anyway).
 */
function newProjectId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // Defensive fallback. Sufficient uniqueness for a desktop IDE.
  return `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ---------------------------------------------------------------------------
// State + actions
// ---------------------------------------------------------------------------

export interface WorkspaceState {
  // ----- state ----------------------------------------------------------

  /** The active project, or `null` while on Welcome. */
  project: Project | null
  /** Repos for the active project — derived; mirrors `project.repos`. */
  repos: Repo[]

  /** Open tabs in left-to-right order. */
  openTabs: OpenTab[]
  /** Path of the focused tab, or `null` when no tab is active. */
  activeTabPath: string | null

  /** Stack of recently-closed file paths for reopen (⌘⇧T). Most-recent last. */
  recentlyClosed: string[]

  // ----- split editor group (E5-01) -------------------------------------

  /** Tabs in the secondary (side) editor group; empty when not split. */
  secondaryTabs: OpenTab[]
  /** Active tab path in the secondary group. */
  secondaryActiveTabPath: string | null
  /** Which group has focus — drives where reveal/open lands. */
  activeGroup: 'primary' | 'secondary'

  /** In-memory file contents keyed by absolute path. */
  contentsCache: Record<string, string>
  /** Convenience dirty lookup keyed by absolute path. */
  dirtyMap: Record<string, boolean>

  /** Absolute paths of folders the user has expanded in the explorer. */
  expandedSet: Set<string>

  /**
   * Lazy directory listings cached by absolute folder path.
   *
   * Populated by the Explorer the first time a folder is expanded; reused on
   * subsequent expands. Invalidated explicitly on Refresh and on rename /
   * delete of any entry whose parent is cached.
   */
  childrenCache: Record<string, DirEntry[]>

  /**
   * Path of the tree node currently focused in the Explorer (file or folder).
   * Drives the highlight, the context menu's "target", and the keyboard
   * shortcuts (Enter renames, ⌫ deletes, ⌘N inserts under selected).
   *
   * Distinct from `activeTabPath` — the Explorer can highlight a file that
   * isn't the focused tab (you can arrow through the tree without leaving
   * your current editor tab).
   */
  selectedExplorerPath: string | null

  /** Recent projects shown on Welcome (max 10, most-recent first). */
  recents: RecentEntry[]

  // ----- editor status (E11-02, E11-03) ---------------------------------

  /**
   * Active editor cursor position (1-based) + selection length, or `null`
   * when no editor is focused. Drives the status-bar position item.
   */
  cursorPosition: {
    line: number
    column: number
    selectionLength?: number
  } | null

  /** Monaco language id of the active editor, or `null`. */
  activeLanguage: string | null

  /**
   * A one-shot request to reveal a position in a freshly-opened editor.
   * Set by global search / go-to-line; consumed (and cleared) by the editor
   * once it mounts the matching path. 1-based line/column.
   */
  pendingReveal: { path: string; line: number; column?: number } | null

  /** Active merge-conflict resolution target (E7-06), or null. */
  mergeTarget: { repoPath: string; path: string } | null

  // ----- layout (REQ-005) -----------------------------------------------

  /** Pixel width of the file-explorer column. Clamped 180–600. */
  explorerWidth: number
  /** Pixel width of the agent-dock column. Clamped 220–640. */
  dockWidth: number
  /** Pixel height of the bottom panel. Clamped 120 .. dynamic max. */
  panelHeight: number

  // ----- plugins (REQ-006) ----------------------------------------------

  /**
   * Live snapshot of plugins discovered on disk. Refreshed on boot and
   * after every install / uninstall via `setPlugins`. Never includes
   * implicit Monaco languages — only installed third-party plugins.
   */
  plugins: LoadedPlugin[]

  /**
   * Per-project map of which plugins are enabled. Keyed by `Project.id`,
   * value is the set of enabled plugin ids. Mirrored to disk as part of
   * `PersistedState.enabledPlugins`.
   */
  enabledPlugins: Record<string, string[]>

  // ----- source control (REQ-008) ---------------------------------------

  /**
   * Per-repo SCM snapshot, keyed by the repo's absolute path. Populated
   * by `fetchScm` / `fetchAllScm`. Repos with no entry yet (or for which
   * the most recent fetch failed) read as `undefined`.
   */
  scm: Record<string, RepoScmState | undefined>

  // ----- ui routing + terminals (REQ-009) -------------------------------

  /** Foreground view the workarea is routing to. Persisted per-project. */
  activeView: WorkspaceView
  /** Whether the bottom panel is open. */
  panelOpen: boolean
  /** Active bottom-panel tab. */
  panelTab: WorkspacePanelTab
  /** Write-through mirror of bottom-panel terminal tabs (names + cwd); shells re-spawn fresh on restore. */
  panelTerminals: PanelTerminalTab[]
  /** Focused bottom-panel terminal tab id, or null. */
  activePanelTerminalId: string | null
  /** Write-through mirror of full-screen terminal sessions (names + split layout); shells re-spawn fresh on restore. */
  termSessions: TermSessionSnapshot[]
  /** Focused full-screen terminal session id, or null. */
  activeTermSessionId: string | null

  // ----- actions --------------------------------------------------------

  /**
   * Open a tab for `path`. No-op-but-focus if the tab is already open.
   * Does NOT load file contents — the caller (Editor) reads from disk
   * via IPC and seeds `contentsCache` via `updateContent`.
   */
  openTab: (path: string, opts?: { preview?: boolean }) => void

  /** Pin a preview tab so it survives the next single-click open (E5-04). */
  pinTab: (path: string) => void

  /**
   * Open (or focus, when already open) a diff tab — REQ-008. The
   * synthetic `path` is `diff:<ref>:<absPath>`; the diff view fetches
   * its left/right sides on demand from `diffMeta`.
   */
  openDiffTab: (meta: {
    repoPath: string
    path: string
    ref: 'index' | 'head'
    label: string
  }) => void

  /**
   * Close the tab for `path`. If it was the active tab, focus moves to
   * the right-hand neighbour, then the left, then `null`.
   * Drops the file from `contentsCache` and `dirtyMap`.
   */
  closeTab: (path: string) => void

  /** Close every tab except `path`. */
  closeOtherTabs: (path: string) => void
  /** Close every tab to the right of `path`. */
  closeTabsToRight: (path: string) => void
  /** Close all saved (non-dirty) tabs. */
  closeSavedTabs: () => void
  /** Reopen the most-recently-closed tab (⌘⇧T). No-op when the stack is empty. */
  reopenClosedTab: () => void

  // ----- split editor group actions (E5-01, E5-02) ----------------------

  /** Open `path` in the secondary group (creating the split). Focuses it. */
  openInSecondary: (path: string) => void
  /** Set the active tab in the secondary group. */
  setSecondaryActive: (path: string | null) => void
  /** Close a tab in the secondary group; collapses the split when last. */
  closeSecondaryTab: (path: string) => void
  /** Mark which editor group is focused. */
  setActiveGroup: (group: 'primary' | 'secondary') => void
  /** Move a tab to the given group (drag between groups, E5-03). */
  moveTabToGroup: (path: string, target: 'primary' | 'secondary') => void
  /** Merge the secondary group back into the primary (single-column, E5-10). */
  collapseToPrimary: () => void
  /**
   * Open `path` "to the side": in the secondary group when focus is in the
   * primary, otherwise in the primary. Mirrors VSCode's split-open behaviour.
   */
  openToSide: (path: string) => void

  /** Set or clear the dirty flag for an open tab. No-op if path isn't open. */
  markDirty: (path: string, dirty: boolean) => void

  /**
   * Seed `contentsCache` with the on-disk content for `path` without marking
   * the tab dirty. The Explorer / Editor use this after a successful
   * `fs.readFile` — the in-memory copy now matches disk, so dirty must
   * stay false.
   */
  loadContent: (path: string, contents: string) => void

  /**
   * Set the active tab. Pass `null` to clear focus.
   * Silently ignored when `path` is not currently open.
   */
  setActive: (path: string | null) => void

  /**
   * Update the in-memory content for `path`.
   * Marks the tab dirty as a side effect (the editor decides what's "dirty"
   * by comparing to disk on save — here we treat any in-memory edit as dirty).
   */
  updateContent: (path: string, next: string) => void

  /** Persist Monaco's view state for a tab (cursor / scroll / folds). */
  setViewState: (path: string, vs: EditorViewState) => void

  /** Set the active editor's cursor position (or clear with `null`). */
  setCursorPosition: (
    pos: { line: number; column: number; selectionLength?: number } | null,
  ) => void

  /** Set the active editor's language id (or clear with `null`). */
  setActiveLanguage: (lang: string | null) => void

  /**
   * Open `path` (if needed) and request the editor reveal `line`/`column`.
   * The reveal is consumed once by the editor on mount/update.
   */
  revealInFile: (path: string, line: number, column?: number) => void

  /** Clear a consumed pending reveal. */
  clearPendingReveal: () => void

  /** Open / close the merge-conflict resolver for a file (E7-06). */
  setMergeTarget: (target: { repoPath: string; path: string } | null) => void

  /** Toggle an explorer folder's expanded state. */
  toggleExpand: (path: string) => void

  /**
   * Set the explorer's expanded state for `path` explicitly.
   * Preferred over `toggleExpand` when the caller already knows the desired
   * value (e.g. opening a folder before fetching its children).
   */
  setExpanded: (path: string, expanded: boolean) => void

  /** Cache the lazy listing for `path`. Replaces any prior entry. */
  cacheChildren: (path: string, children: DirEntry[]) => void

  /**
   * Drop the cached listing for `path` so the next render re-fetches via
   * `window.hive.fs.listDir(path)`. Used by Refresh + after rename / delete
   * to invalidate the parent's listing.
   */
  invalidateChildren: (path: string) => void

  /** Set the currently-focused Explorer node, or clear it with `null`. */
  setSelectedExplorerPath: (path: string | null) => void

  /**
   * Rewrite paths in `openTabs`, `activeTabPath`, `contentsCache`,
   * `dirtyMap`, and `childrenCache` from `oldPath` to `newPath`. Any path
   * *under* `oldPath` (a descendant when the renamed entry is a folder) is
   * rewritten with the matching prefix, so renaming `/a/foo` carries
   * `/a/foo/bar.ts` along to `/a/foo-renamed/bar.ts`.
   *
   * The Explorer calls this after a successful `fs.rename`, so the open
   * editor doesn't quietly point at a path that no longer exists.
   */
  renamePath: (oldPath: string, newPath: string) => void

  /**
   * Restore from a persisted session snapshot. Replaces:
   * - `openTabs`
   * - `activeTabPath`
   * - `expandedSet`
   * Leaves `contentsCache` / `dirtyMap` untouched — the editor reloads
   * each open tab's contents from disk after hydration.
   */
  hydrateFromSession: (snapshot: ProjectSessionSnapshot) => void

  /**
   * Swap in a new project. Clears all tab / explorer state — the caller
   * follows up with `hydrateFromSession` if a snapshot exists for the
   * new project.
   *
   * Pass `null` to return to Welcome.
   */
  setProject: (project: Project | null) => void

  /** Bind (or clear) the hive workspace path on the active project. */
  setHiveWorkspacePath: (path: string | null) => void

  /**
   * Create a fresh project with the given user-given name (trimmed,
   * required). Empty repos. Sets it as the active project, pushes a
   * recent for it, and returns the new Project.
   *
   * Throws when `name` is blank after trimming.
   */
  createProject: (name: string) => Project

  /**
   * Add a folder to the active project by calling
   * `window.hive.project.inspectFolder(path)` and appending the resulting
   * `Repo` to `project.repos`.
   *
   * No-op when:
   *   - there is no active project, or
   *   - a repo with the same absolute `path` is already in the list.
   */
  addRepoToProject: (path: string) => Promise<void>

  /** Remove a repo from the active project by absolute path. No-op if missing. */
  removeRepoFromProject: (path: string) => void

  /**
   * Rename the project with id `id` to `name`. No-op for an unknown id or
   * when the name is empty after trimming. Updates the active project +
   * the matching recents entry.
   */
  renameProject: (id: string, name: string) => void

  /** Clear the active project — the user returns to Welcome. */
  closeProject: () => void

  /**
   * Push a recent entry, deduping by `id` and capping at 10.
   * Most-recent first. Delegated to `recents.ts`.
   */
  pushRecent: (entry: RecentEntry) => void

  // ----- layout actions (REQ-005) ---------------------------------------

  /** Set the explorer column width. Caller is responsible for clamping. */
  setExplorerWidth: (px: number) => void
  /** Set the agent-dock column width. Caller is responsible for clamping. */
  setDockWidth: (px: number) => void
  /** Set the bottom-panel height. Caller is responsible for clamping. */
  setPanelHeight: (px: number) => void
  /**
   * Replace the layout snapshot wholesale — called on boot once persisted
   * state is hydrated from main.
   */
  hydrateLayout: (layout: LayoutSnapshot) => void

  // ----- plugin actions (REQ-006) ---------------------------------------

  /**
   * Replace the live plugins snapshot. Called on boot after
   * `window.hive.plugins.list()` resolves, and again after every install
   * / uninstall.
   */
  setPlugins: (plugins: LoadedPlugin[]) => void

  /**
   * Replace the persisted `enabledPlugins` map. Called on boot from the
   * persisted state. Pass `{}` to clear.
   */
  hydrateEnabledPlugins: (enabled: Record<string, string[]>) => void

  /**
   * True when `pluginId` is enabled for the currently-active project.
   * Returns `false` when no project is active (no scope to enable in).
   */
  isPluginEnabled: (pluginId: string) => boolean

  /**
   * Toggle the enabled state of `pluginId` for the active project. No-op
   * when no project is active. Persisted via the existing app-shell save
   * subscription — no extra IPC call needed.
   */
  setPluginEnabled: (pluginId: string, enabled: boolean) => void

  // ----- source-control actions (REQ-008) -------------------------------

  /**
   * Refresh git status + ahead/behind + branch for a single repo. Runs
   * three IPC calls in series (status, branches, ahead/behind would be
   * redundant — the branch header in status already carries it, so
   * `fetchScm` only fires `status` + `branches`). On failure the slot is
   * cleared so the UI can show an error placeholder rather than stale
   * data.
   */
  fetchScm: (repoPath: string) => Promise<void>

  /** Refresh SCM state for every repo in the active project, in parallel. */
  fetchAllScm: () => Promise<void>

  // ----- ui-routing + terminal actions (REQ-009) ------------------------

  setActiveView: (view: WorkspaceView) => void
  setPanelOpen: (open: boolean) => void
  setPanelTab: (tab: WorkspacePanelTab) => void
  setPanelTerminals: (tabs: PanelTerminalTab[]) => void
  setActivePanelTerminalId: (id: string | null) => void
  setTermSessions: (sessions: TermSessionSnapshot[]) => void
  setActiveTermSessionId: (id: string | null) => void

  /**
   * Replace the workspace-global terminal state from a persisted snapshot
   * (REQ-010). Called once on boot after `state.get()` resolves. Falls back
   * to empty defaults for any missing field. Unlike `hydrateFromSession`,
   * this is project-independent — terminals are shared across projects.
   */
  hydrateTerminals: (snapshot: TerminalsSnapshot) => void
}

/**
 * Per-repo SCM snapshot — populated by `fetchScm`.
 */
export interface RepoScmState {
  entries: GitStatusEntry[]
  ahead: number
  behind: number
  /** Current branch name, or `null` when detached HEAD. */
  branch: string | null
  /** Unix milliseconds; useful for staleness debugging. */
  lastFetchedAt: number
}

// ---------------------------------------------------------------------------
// Layout defaults (REQ-005)
// ---------------------------------------------------------------------------

/** Default panel sizes — also re-used by the v2→v3 store migrator in main. */
export const DEFAULT_LAYOUT: LayoutSnapshot = {
  explorerWidth: 256,
  dockWidth: 344,
  panelHeight: 232,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Per-project view chrome — reset on project swap, restored per project. */
const VIEW_DEFAULTS = {
  activeView: 'ide' as WorkspaceView,
  panelOpen: true,
  panelTab: 'log' as WorkspacePanelTab,
}

/** Workspace-global terminal state — NOT reset on project swap. Seeded once. */
const TERMINAL_DEFAULTS = {
  panelTerminals: [] as PanelTerminalTab[],
  activePanelTerminalId: null as string | null,
  termSessions: [] as TermSessionSnapshot[],
  activeTermSessionId: null as string | null,
}

const INITIAL_STATE: Pick<
  WorkspaceState,
  | 'project'
  | 'repos'
  | 'openTabs'
  | 'activeTabPath'
  | 'recentlyClosed'
  | 'secondaryTabs'
  | 'secondaryActiveTabPath'
  | 'activeGroup'
  | 'contentsCache'
  | 'dirtyMap'
  | 'expandedSet'
  | 'childrenCache'
  | 'selectedExplorerPath'
  | 'recents'
  | 'cursorPosition'
  | 'activeLanguage'
  | 'pendingReveal'
  | 'mergeTarget'
  | 'explorerWidth'
  | 'dockWidth'
  | 'panelHeight'
  | 'plugins'
  | 'enabledPlugins'
  | 'scm'
  | 'activeView'
  | 'panelOpen'
  | 'panelTab'
  | 'panelTerminals'
  | 'activePanelTerminalId'
  | 'termSessions'
  | 'activeTermSessionId'
> = {
  project: null,
  repos: [],
  openTabs: [],
  activeTabPath: null,
  recentlyClosed: [],
  secondaryTabs: [],
  secondaryActiveTabPath: null,
  activeGroup: 'primary',
  contentsCache: {},
  dirtyMap: {},
  expandedSet: new Set<string>(),
  childrenCache: {},
  selectedExplorerPath: null,
  recents: [],
  cursorPosition: null,
  activeLanguage: null,
  pendingReveal: null,
  mergeTarget: null,
  explorerWidth: DEFAULT_LAYOUT.explorerWidth,
  dockWidth: DEFAULT_LAYOUT.dockWidth,
  panelHeight: DEFAULT_LAYOUT.panelHeight,
  plugins: [],
  enabledPlugins: {},
  scm: {},
  ...VIEW_DEFAULTS,
  ...TERMINAL_DEFAULTS,
}

// Module-scoped coalescing latch for `fetchAllScm`. Kept out of store state
// so it never triggers a re-render. A project switch + the fs-change pipeline
// can fire `fetchAllScm` several times in a burst; without this each burst
// spawned `3 × repos` git subprocesses concurrently and saturated the main
// process (the "hangs on project switch" beachball). We collapse overlapping
// calls into at most one in-flight run plus one trailing re-run.
let scmAllInFlight = false
let scmAllPending = false

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  ...INITIAL_STATE,

  openTab: (path, opts) =>
    set((s) => {
      const existing = s.openTabs.find((t) => t.path === path)
      if (existing !== undefined) {
        // Already open: focus it. A non-preview (pinned) open of a tab that's
        // currently a preview promotes it to pinned.
        if (!opts?.preview && existing.preview) {
          return {
            activeTabPath: path,
            openTabs: s.openTabs.map((t) =>
              t.path === path ? { ...t, preview: false } : t,
            ),
          }
        }
        return { activeTabPath: path }
      }
      const tab: OpenTab = { path, viewState: null, dirty: false, preview: opts?.preview }
      if (opts?.preview) {
        // Replace the existing preview tab (at most one) rather than stacking.
        const idx = s.openTabs.findIndex((t) => t.preview && !t.dirty)
        if (idx !== -1) {
          const openTabs = s.openTabs.slice()
          openTabs[idx] = tab
          return { openTabs, activeTabPath: path }
        }
      }
      return {
        openTabs: [...s.openTabs, tab],
        activeTabPath: path,
      }
    }),

  pinTab: (path) =>
    set((s) => {
      const idx = s.openTabs.findIndex((t) => t.path === path)
      if (idx === -1 || !s.openTabs[idx].preview) return {}
      const openTabs = s.openTabs.slice()
      openTabs[idx] = { ...openTabs[idx], preview: false }
      return { openTabs }
    }),

  openDiffTab: (meta) =>
    set((s) => {
      // Synthetic id — the colon-prefixed scheme guarantees no collision
      // with real absolute paths.
      const id = `diff:${meta.ref}:${meta.repoPath}:${meta.path}`
      if (s.openTabs.some((t) => t.path === id)) {
        return { activeTabPath: id }
      }
      const tab: OpenTab = {
        path: id,
        viewState: null,
        dirty: false,
        diffMeta: meta,
      }
      return {
        openTabs: [...s.openTabs, tab],
        activeTabPath: id,
      }
    }),

  closeTab: (path) =>
    set((s) => {
      const idx = s.openTabs.findIndex((t) => t.path === path)
      if (idx === -1) return {}

      const openTabs = s.openTabs.filter((t) => t.path !== path)

      let activeTabPath = s.activeTabPath
      if (s.activeTabPath === path) {
        const next = openTabs[idx] ?? openTabs[idx - 1] ?? null
        activeTabPath = next ? next.path : null
      }

      const contentsCache = { ...s.contentsCache }
      delete contentsCache[path]
      const dirtyMap = { ...s.dirtyMap }
      delete dirtyMap[path]

      // Remember real (non-diff) closed files so ⌘⇧T can reopen them.
      const recentlyClosed = path.startsWith('diff:')
        ? s.recentlyClosed
        : [...s.recentlyClosed.filter((p) => p !== path), path].slice(-20)

      return { openTabs, activeTabPath, contentsCache, dirtyMap, recentlyClosed }
    }),

  closeOtherTabs: (path) =>
    set((s) => {
      const kept = s.openTabs.filter((t) => t.path === path)
      if (kept.length === s.openTabs.length) return {}
      const closed = s.openTabs
        .filter((t) => t.path !== path && !t.path.startsWith('diff:'))
        .map((t) => t.path)
      const contentsCache = { ...s.contentsCache }
      const dirtyMap = { ...s.dirtyMap }
      for (const t of s.openTabs) {
        if (t.path !== path) {
          delete contentsCache[t.path]
          delete dirtyMap[t.path]
        }
      }
      return {
        openTabs: kept,
        activeTabPath: path,
        contentsCache,
        dirtyMap,
        recentlyClosed: [...s.recentlyClosed, ...closed].slice(-20),
      }
    }),

  closeTabsToRight: (path) =>
    set((s) => {
      const idx = s.openTabs.findIndex((t) => t.path === path)
      if (idx === -1 || idx === s.openTabs.length - 1) return {}
      const kept = s.openTabs.slice(0, idx + 1)
      const removed = s.openTabs.slice(idx + 1)
      const contentsCache = { ...s.contentsCache }
      const dirtyMap = { ...s.dirtyMap }
      for (const t of removed) {
        delete contentsCache[t.path]
        delete dirtyMap[t.path]
      }
      const activeStillOpen = kept.some((t) => t.path === s.activeTabPath)
      const closed = removed
        .filter((t) => !t.path.startsWith('diff:'))
        .map((t) => t.path)
      return {
        openTabs: kept,
        activeTabPath: activeStillOpen ? s.activeTabPath : path,
        contentsCache,
        dirtyMap,
        recentlyClosed: [...s.recentlyClosed, ...closed].slice(-20),
      }
    }),

  closeSavedTabs: () =>
    set((s) => {
      const kept = s.openTabs.filter((t) => t.dirty)
      if (kept.length === s.openTabs.length) return {}
      const removed = s.openTabs.filter((t) => !t.dirty)
      const contentsCache = { ...s.contentsCache }
      const dirtyMap = { ...s.dirtyMap }
      for (const t of removed) {
        delete contentsCache[t.path]
        delete dirtyMap[t.path]
      }
      const activeStillOpen = kept.some((t) => t.path === s.activeTabPath)
      const closed = removed
        .filter((t) => !t.path.startsWith('diff:'))
        .map((t) => t.path)
      return {
        openTabs: kept,
        activeTabPath: activeStillOpen ? s.activeTabPath : (kept[0]?.path ?? null),
        contentsCache,
        dirtyMap,
        recentlyClosed: [...s.recentlyClosed, ...closed].slice(-20),
      }
    }),

  reopenClosedTab: () =>
    set((s) => {
      const stack = [...s.recentlyClosed]
      const path = stack.pop()
      if (path === undefined) return {}
      if (s.openTabs.some((t) => t.path === path)) {
        return { recentlyClosed: stack, activeTabPath: path }
      }
      return {
        recentlyClosed: stack,
        openTabs: [...s.openTabs, { path, viewState: null, dirty: false }],
        activeTabPath: path,
      }
    }),

  openInSecondary: (path) =>
    set((s) => {
      const exists = s.secondaryTabs.some((t) => t.path === path)
      const secondaryTabs = exists
        ? s.secondaryTabs
        : [...s.secondaryTabs, { path, viewState: null, dirty: false }]
      return {
        secondaryTabs,
        secondaryActiveTabPath: path,
        activeGroup: 'secondary',
      }
    }),

  setSecondaryActive: (path) =>
    set((s) => {
      if (path !== null && !s.secondaryTabs.some((t) => t.path === path)) return {}
      return { secondaryActiveTabPath: path, activeGroup: 'secondary' }
    }),

  closeSecondaryTab: (path) =>
    set((s) => {
      const idx = s.secondaryTabs.findIndex((t) => t.path === path)
      if (idx === -1) return {}
      const secondaryTabs = s.secondaryTabs.filter((t) => t.path !== path)
      let secondaryActiveTabPath = s.secondaryActiveTabPath
      if (s.secondaryActiveTabPath === path) {
        const next = secondaryTabs[idx] ?? secondaryTabs[idx - 1] ?? null
        secondaryActiveTabPath = next ? next.path : null
      }
      const recentlyClosed = path.startsWith('diff:')
        ? s.recentlyClosed
        : [...s.recentlyClosed.filter((p) => p !== path), path].slice(-20)
      // Collapse focus back to primary when the side group empties.
      const activeGroup = secondaryTabs.length === 0 ? 'primary' : s.activeGroup
      return { secondaryTabs, secondaryActiveTabPath, recentlyClosed, activeGroup }
    }),

  setActiveGroup: (group) =>
    set((s) => (s.activeGroup === group ? {} : { activeGroup: group })),

  moveTabToGroup: (path, target) =>
    set((s) => {
      const tab =
        s.openTabs.find((t) => t.path === path) ??
        s.secondaryTabs.find((t) => t.path === path)
      if (tab === undefined) return {}
      const openTabs = s.openTabs.filter((t) => t.path !== path)
      const secondaryTabs = s.secondaryTabs.filter((t) => t.path !== path)
      if (target === 'primary') {
        return {
          openTabs: [...openTabs, tab],
          secondaryTabs,
          activeTabPath: path,
          activeGroup: 'primary',
          secondaryActiveTabPath:
            s.secondaryActiveTabPath === path
              ? (secondaryTabs[0]?.path ?? null)
              : s.secondaryActiveTabPath,
        }
      }
      return {
        openTabs,
        secondaryTabs: [...secondaryTabs, tab],
        secondaryActiveTabPath: path,
        activeGroup: 'secondary',
        activeTabPath:
          s.activeTabPath === path ? (openTabs[0]?.path ?? null) : s.activeTabPath,
      }
    }),

  collapseToPrimary: () =>
    set((s) => {
      if (s.secondaryTabs.length === 0) return {}
      const existing = new Set(s.openTabs.map((t) => t.path))
      const merged = [
        ...s.openTabs,
        ...s.secondaryTabs.filter((t) => !existing.has(t.path)),
      ]
      return {
        openTabs: merged,
        secondaryTabs: [],
        secondaryActiveTabPath: null,
        activeGroup: 'primary',
      }
    }),

  openToSide: (path) => {
    const s = get()
    if (s.activeGroup === 'primary') {
      get().openInSecondary(path)
    } else {
      get().openTab(path)
      set({ activeGroup: 'primary' })
    }
  },

  markDirty: (path, dirty) =>
    set((s) => {
      const idx = s.openTabs.findIndex((t) => t.path === path)
      if (idx === -1) return {}
      if (s.openTabs[idx].dirty === dirty) return {}

      const openTabs = s.openTabs.slice()
      openTabs[idx] = { ...openTabs[idx], dirty }
      return {
        openTabs,
        dirtyMap: { ...s.dirtyMap, [path]: dirty },
      }
    }),

  loadContent: (path, contents) =>
    set((s) => ({
      contentsCache: { ...s.contentsCache, [path]: contents },
    })),

  setActive: (path) =>
    set((s) => {
      if (path === null) return { activeTabPath: null }
      if (!s.openTabs.some((t) => t.path === path)) return {}
      return { activeTabPath: path }
    }),

  updateContent: (path, next) =>
    set((s) => {
      const contentsCache = { ...s.contentsCache, [path]: next }
      const idx = s.openTabs.findIndex((t) => t.path === path)
      if (idx === -1) {
        return { contentsCache }
      }
      const openTabs = s.openTabs.slice()
      if (!openTabs[idx].dirty || openTabs[idx].preview) {
        // Editing pins a preview tab (E5-04) and marks it dirty.
        openTabs[idx] = { ...openTabs[idx], dirty: true, preview: false }
      }
      return {
        contentsCache,
        openTabs,
        dirtyMap: { ...s.dirtyMap, [path]: true },
      }
    }),

  setViewState: (path, vs) =>
    set((s) => {
      const idx = s.openTabs.findIndex((t) => t.path === path)
      if (idx === -1) return {}
      const openTabs = s.openTabs.slice()
      openTabs[idx] = { ...openTabs[idx], viewState: vs }
      return { openTabs }
    }),

  setCursorPosition: (pos) =>
    set((s) => {
      const cur = s.cursorPosition
      if (
        cur === pos ||
        (cur !== null &&
          pos !== null &&
          cur.line === pos.line &&
          cur.column === pos.column &&
          cur.selectionLength === pos.selectionLength)
      ) {
        return {}
      }
      return { cursorPosition: pos }
    }),

  setActiveLanguage: (lang) =>
    set((s) => (s.activeLanguage === lang ? {} : { activeLanguage: lang })),

  revealInFile: (path, line, column) =>
    set((s) => {
      // Open the tab if it isn't already, and focus it.
      const isOpen = s.openTabs.some((t) => t.path === path)
      const openTabs = isOpen
        ? s.openTabs
        : [...s.openTabs, { path, viewState: null, dirty: false }]
      return {
        openTabs,
        activeTabPath: path,
        pendingReveal: { path, line, column },
      }
    }),

  clearPendingReveal: () => set(() => ({ pendingReveal: null })),

  setMergeTarget: (target) => set(() => ({ mergeTarget: target })),

  toggleExpand: (path) =>
    set((s) => {
      const expandedSet = new Set(s.expandedSet)
      if (expandedSet.has(path)) expandedSet.delete(path)
      else expandedSet.add(path)
      return { expandedSet }
    }),

  setExpanded: (path, expanded) =>
    set((s) => {
      const has = s.expandedSet.has(path)
      if (has === expanded) return {}
      const expandedSet = new Set(s.expandedSet)
      if (expanded) expandedSet.add(path)
      else expandedSet.delete(path)
      return { expandedSet }
    }),

  cacheChildren: (path, children) =>
    set((s) => ({
      childrenCache: { ...s.childrenCache, [path]: children },
    })),

  invalidateChildren: (path) =>
    set((s) => {
      if (!(path in s.childrenCache)) return {}
      const childrenCache = { ...s.childrenCache }
      delete childrenCache[path]
      return { childrenCache }
    }),

  setSelectedExplorerPath: (path) =>
    set(() => ({ selectedExplorerPath: path })),

  renamePath: (oldPath, newPath) =>
    set((s) => {
      // openTabs — rewrite paths in place; preserves order, viewState, dirty.
      const openTabs = s.openTabs.map((t) => {
        const next = rewritePath(t.path, oldPath, newPath)
        return next === t.path ? t : { ...t, path: next }
      })

      const activeTabPath =
        s.activeTabPath === null
          ? null
          : rewritePath(s.activeTabPath, oldPath, newPath)

      const contentsCache: Record<string, string> = {}
      for (const [k, v] of Object.entries(s.contentsCache)) {
        contentsCache[rewritePath(k, oldPath, newPath)] = v
      }

      const dirtyMap: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(s.dirtyMap)) {
        dirtyMap[rewritePath(k, oldPath, newPath)] = v
      }

      const childrenCache: Record<string, DirEntry[]> = {}
      for (const [k, entries] of Object.entries(s.childrenCache)) {
        const nextKey = rewritePath(k, oldPath, newPath)
        // Each entry's `path` also needs rewriting if it falls under oldPath.
        childrenCache[nextKey] = entries.map((e) => {
          const nextPath = rewritePath(e.path, oldPath, newPath)
          return nextPath === e.path ? e : { ...e, path: nextPath }
        })
      }

      // expandedSet — folder paths may need rewriting too.
      const expandedSet = new Set<string>()
      for (const p of s.expandedSet) {
        expandedSet.add(rewritePath(p, oldPath, newPath))
      }

      const selectedExplorerPath =
        s.selectedExplorerPath === null
          ? null
          : rewritePath(s.selectedExplorerPath, oldPath, newPath)

      return {
        openTabs,
        activeTabPath,
        contentsCache,
        dirtyMap,
        childrenCache,
        expandedSet,
        selectedExplorerPath,
      }
    }),

  hydrateFromSession: (snapshot) =>
    set(() => ({
      openTabs: snapshot.openTabs.map((t) => ({ ...t })),
      activeTabPath: snapshot.activeTabPath,
      secondaryTabs: (snapshot.secondaryTabs ?? []).map((t) => ({ ...t })),
      secondaryActiveTabPath: snapshot.secondaryActiveTabPath ?? null,
      activeGroup: 'primary' as const,
      expandedSet: new Set(snapshot.expandedPaths),
      dirtyMap: Object.fromEntries(
        snapshot.openTabs.filter((t) => t.dirty).map((t) => [t.path, true]),
      ),
      activeView: snapshot.activeView ?? VIEW_DEFAULTS.activeView,
      panelOpen: snapshot.panelOpen ?? VIEW_DEFAULTS.panelOpen,
      panelTab: snapshot.panelTab ?? VIEW_DEFAULTS.panelTab,
    })),

  setProject: (project) =>
    set(() => ({
      project,
      repos: project ? project.repos : [],
      openTabs: [],
      activeTabPath: null,
      secondaryTabs: [],
      secondaryActiveTabPath: null,
      activeGroup: 'primary' as const,
      contentsCache: {},
      dirtyMap: {},
      expandedSet: new Set<string>(),
      childrenCache: {},
      selectedExplorerPath: null,
      scm: {},
      ...VIEW_DEFAULTS,
    })),

  setHiveWorkspacePath: (path) =>
    set((s) =>
      s.project
        ? { project: { ...s.project, hiveWorkspacePath: path ?? undefined } }
        : {},
    ),

  createProject: (name) => {
    const trimmed = name.trim()
    if (trimmed === '') {
      throw new Error('Project name is required')
    }
    const now = Date.now()
    const project: Project = {
      id: newProjectId(),
      name: trimmed,
      repos: [],
      createdAt: now,
      lastOpenedAt: now,
    }
    set((s) => ({
      project,
      repos: project.repos,
      openTabs: [],
      activeTabPath: null,
      secondaryTabs: [],
      secondaryActiveTabPath: null,
      activeGroup: 'primary' as const,
      contentsCache: {},
      dirtyMap: {},
      expandedSet: new Set<string>(),
      childrenCache: {},
      selectedExplorerPath: null,
      scm: {},
      ...VIEW_DEFAULTS,
      recents: pushRecentLRU(s.recents, recentFromProject(project)),
    }))
    return project
  },

  addRepoToProject: async (path) => {
    const current = get().project
    if (!current) return
    if (current.repos.some((r) => r.path === path)) return

    const folder = await window.hive.project.inspectFolder(path)
    const repo: Repo = {
      name: folder.name,
      path: folder.path,
      isGitRepo: folder.isGitRepo,
    }

    set((s) => {
      if (!s.project) return {}
      // Re-check inside set() to guard against a racing call slipping in
      // between the inspectFolder await and the state update.
      if (s.project.repos.some((r) => r.path === repo.path)) return {}
      const repos = [...s.project.repos, repo]
      const project: Project = { ...s.project, repos }
      return {
        project,
        repos,
        recents: pushRecentLRU(s.recents, recentFromProject(project)),
      }
    })
  },

  removeRepoFromProject: (path) =>
    set((s) => {
      if (!s.project) return {}
      const next = s.project.repos.filter((r) => r.path !== path)
      if (next.length === s.project.repos.length) return {}
      const project: Project = { ...s.project, repos: next }
      return {
        project,
        repos: next,
        recents: pushRecentLRU(s.recents, recentFromProject(project)),
      }
    }),

  renameProject: (id, name) =>
    set((s) => {
      const trimmed = name.trim()
      if (trimmed === '') return {}

      const recents = s.recents.map((r) =>
        r.id === id ? { ...r, name: trimmed } : r,
      )

      if (s.project && s.project.id === id) {
        const project: Project = { ...s.project, name: trimmed }
        return { project, recents }
      }
      return { recents }
    }),

  closeProject: () =>
    set(() => ({
      project: null,
      repos: [],
      openTabs: [],
      activeTabPath: null,
      secondaryTabs: [],
      secondaryActiveTabPath: null,
      activeGroup: 'primary' as const,
      contentsCache: {},
      dirtyMap: {},
      expandedSet: new Set<string>(),
      childrenCache: {},
      selectedExplorerPath: null,
      scm: {},
      ...VIEW_DEFAULTS,
    })),

  pushRecent: (entry) =>
    set((s) => ({ recents: pushRecentLRU(s.recents, entry) })),

  // ----- layout actions (REQ-005) ---------------------------------------

  setExplorerWidth: (px) =>
    set((s) => (s.explorerWidth === px ? {} : { explorerWidth: px })),

  setDockWidth: (px) =>
    set((s) => (s.dockWidth === px ? {} : { dockWidth: px })),

  setPanelHeight: (px) =>
    set((s) => (s.panelHeight === px ? {} : { panelHeight: px })),

  hydrateLayout: (layout) =>
    set(() => ({
      explorerWidth: layout.explorerWidth,
      dockWidth: layout.dockWidth,
      panelHeight: layout.panelHeight,
    })),

  // ----- plugin actions (REQ-006) ---------------------------------------

  setPlugins: (plugins) =>
    set(() => ({ plugins })),

  hydrateEnabledPlugins: (enabled) =>
    set(() => ({ enabledPlugins: enabled })),

  isPluginEnabled: (pluginId) => {
    const s = get()
    const projectId = s.project?.id
    if (!projectId) return false
    const ids = s.enabledPlugins[projectId]
    return ids !== undefined && ids.includes(pluginId)
  },

  setPluginEnabled: (pluginId, enabled) =>
    set((s) => {
      const projectId = s.project?.id
      if (!projectId) return {}
      const current = s.enabledPlugins[projectId] ?? []
      const has = current.includes(pluginId)
      if (enabled === has) return {}

      let nextForProject: string[]
      if (enabled) {
        // Enabling also enables declared dependencies, transitively (E10-08).
        const toEnable = new Set(current)
        const stack = [pluginId]
        while (stack.length > 0) {
          const id = stack.pop() as string
          if (toEnable.has(id)) continue
          toEnable.add(id)
          const dep = s.plugins.find((p) => p.manifest.id === id)
          for (const d of dep?.manifest.dependencies ?? []) {
            if (!toEnable.has(d)) stack.push(d)
          }
        }
        nextForProject = [...toEnable]
      } else {
        nextForProject = current.filter((id) => id !== pluginId)
      }
      return {
        enabledPlugins: {
          ...s.enabledPlugins,
          [projectId]: nextForProject,
        },
      }
    }),

  // ----- source-control actions (REQ-008) -------------------------------

  fetchScm: async (repoPath) => {
    // ONE git invocation per repo: `status --porcelain=v2 --branch -z` carries
    // the changed entries, the current branch, AND ahead/behind. Previously
    // this fired three git subprocesses (status + branch + ahead-behind) per
    // repo; with several large repos that storm saturated the main process on
    // project switch (the IDE "hangs on switch" beachball). The branch *list*
    // (for the switcher dropdown) is fetched on demand elsewhere.
    try {
      const summary = await window.hive.git.status(repoPath)
      set((s) => ({
        scm: {
          ...s.scm,
          [repoPath]: {
            entries: summary.entries,
            ahead: summary.ahead,
            behind: summary.behind,
            branch: summary.branch,
            lastFetchedAt: Date.now(),
          },
        },
      }))
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('fetchScm failed for', repoPath, err)
      set((s) => {
        const next = { ...s.scm }
        delete next[repoPath]
        return { scm: next }
      })
    }
  },

  fetchAllScm: async () => {
    // Coalesce overlapping calls: while one run is in flight, later calls just
    // mark a trailing re-run instead of spawning another full git burst.
    if (scmAllInFlight) {
      scmAllPending = true
      return
    }
    scmAllInFlight = true
    try {
      do {
        scmAllPending = false
        const repos = get().repos
        await Promise.all(
          repos
            .filter((r) => r.isGitRepo)
            .map((r) => get().fetchScm(r.path)),
        )
      } while (scmAllPending)
    } finally {
      scmAllInFlight = false
    }
  },

  // ----- ui-routing + terminal actions (REQ-009) ------------------------

  setActiveView: (view) =>
    set((s) => (s.activeView === view ? {} : { activeView: view })),
  setPanelOpen: (open) =>
    set((s) => (s.panelOpen === open ? {} : { panelOpen: open })),
  setPanelTab: (tab) =>
    set((s) => (s.panelTab === tab ? {} : { panelTab: tab })),
  setPanelTerminals: (tabs) => set(() => ({ panelTerminals: tabs })),
  setActivePanelTerminalId: (id) =>
    set((s) =>
      s.activePanelTerminalId === id ? {} : { activePanelTerminalId: id },
    ),
  setTermSessions: (sessions) => set(() => ({ termSessions: sessions })),
  setActiveTermSessionId: (id) =>
    set((s) =>
      s.activeTermSessionId === id ? {} : { activeTermSessionId: id },
    ),

  hydrateTerminals: (snapshot) =>
    set(() => ({
      panelTerminals: snapshot.panelTerminals ?? TERMINAL_DEFAULTS.panelTerminals,
      activePanelTerminalId:
        snapshot.activePanelTerminalId ?? TERMINAL_DEFAULTS.activePanelTerminalId,
      termSessions: snapshot.termSessions ?? TERMINAL_DEFAULTS.termSessions,
      activeTermSessionId:
        snapshot.activeTermSessionId ?? TERMINAL_DEFAULTS.activeTermSessionId,
    })),
}))
