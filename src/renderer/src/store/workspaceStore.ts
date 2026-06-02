/**
 * Renderer Zustand workspace store — the single source of truth for the IDE.
 *
 * This is the fanout point every other renderer story consumes
 * (Editor, Explorer, Welcome, App shell, banners, ribbons). The exported
 * actions + state shape are the contract those stories build against.
 *
 * Rules:
 * - **No IPC inside the store.** Actions take values and return values;
 *   side effects (fs reads, watcher subscriptions, persistence) happen at
 *   the component / effect level.
 * - **Type-only imports across process boundaries.** Nothing here imports
 *   anything from `main` / `preload` at runtime — Vite would happily bundle
 *   those modules into the renderer, but we'd quietly ship dead Electron
 *   code. Type-only imports from `src/types/workspace.ts` are fine.
 * - **Strongly typed.** No `any`. `unknown` (e.g. `EditorViewState`)
 *   appears where a downstream consumer narrows.
 */

import { create } from 'zustand'

import type {
  DirEntry,
  EditorViewState,
  OpenTab,
  Project,
  ProjectSessionSnapshot,
  RecentEntry,
  Repo,
} from '../../../types/workspace'

import { pushRecent as pushRecentLRU } from './recents'

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

  // ----- actions --------------------------------------------------------

  /**
   * Open a tab for `path`. No-op-but-focus if the tab is already open.
   * Does NOT load file contents — the caller (Editor) reads from disk
   * via IPC and seeds `contentsCache` via `updateContent`.
   */
  openTab: (path: string) => void

  /**
   * Close the tab for `path`. If it was the active tab, focus moves to
   * the right-hand neighbour, then the left, then `null`.
   * Drops the file from `contentsCache` and `dirtyMap`.
   */
  closeTab: (path: string) => void

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

  /**
   * Push a recent entry, deduping by `id` and capping at 10.
   * Most-recent first. Delegated to `recents.ts`.
   */
  pushRecent: (entry: RecentEntry) => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const INITIAL_STATE: Pick<
  WorkspaceState,
  | 'project'
  | 'repos'
  | 'openTabs'
  | 'activeTabPath'
  | 'contentsCache'
  | 'dirtyMap'
  | 'expandedSet'
  | 'childrenCache'
  | 'selectedExplorerPath'
  | 'recents'
> = {
  project: null,
  repos: [],
  openTabs: [],
  activeTabPath: null,
  contentsCache: {},
  dirtyMap: {},
  expandedSet: new Set<string>(),
  childrenCache: {},
  selectedExplorerPath: null,
  recents: [],
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...INITIAL_STATE,

  openTab: (path) =>
    set((s) => {
      if (s.openTabs.some((t) => t.path === path)) {
        return { activeTabPath: path }
      }
      const tab: OpenTab = { path, viewState: null, dirty: false }
      return {
        openTabs: [...s.openTabs, tab],
        activeTabPath: path,
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

      return { openTabs, activeTabPath, contentsCache, dirtyMap }
    }),

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
      if (!openTabs[idx].dirty) {
        openTabs[idx] = { ...openTabs[idx], dirty: true }
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
      expandedSet: new Set(snapshot.expandedPaths),
      dirtyMap: Object.fromEntries(
        snapshot.openTabs.filter((t) => t.dirty).map((t) => [t.path, true]),
      ),
    })),

  setProject: (project) =>
    set(() => ({
      project,
      repos: project ? project.repos : [],
      openTabs: [],
      activeTabPath: null,
      contentsCache: {},
      dirtyMap: {},
      expandedSet: new Set<string>(),
      childrenCache: {},
      selectedExplorerPath: null,
    })),

  pushRecent: (entry) =>
    set((s) => ({ recents: pushRecentLRU(s.recents, entry) })),
}))
