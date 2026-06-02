import { beforeEach, describe, expect, it } from 'vitest'

import type {
  DirEntry,
  Project,
  ProjectSessionSnapshot,
  RecentEntry,
} from '../../../types/workspace'

import { useWorkspaceStore } from './workspaceStore'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Replace the live store with a fresh initial state between cases. */
function resetStore(): void {
  useWorkspaceStore.setState({
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
  })
}

/** Build a DirEntry quickly for tests. */
const mkEntry = (
  path: string,
  isDir = false,
  name = path.split(/[\\/]/).pop() ?? '',
): DirEntry => ({
  name,
  path,
  isDir,
  isSymlink: false,
  mtime: 0,
})

const mkProject = (id = 'p1'): Project => ({
  id,
  name: id,
  rootPath: `/projects/${id}`,
  source: 'single-repo',
  repos: [{ name: id, path: `/projects/${id}`, isGitRepo: true }],
  lastOpenedAt: 0,
})

const mkRecent = (id: string): RecentEntry => ({
  id,
  name: id,
  rootPath: `/projects/${id}`,
  source: 'auto-detected',
  repoCount: 1,
  lastOpenedAt: 0,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workspaceStore', () => {
  beforeEach(resetStore)

  describe('openTab + closeTab', () => {
    it('opens a tab and focuses it', () => {
      useWorkspaceStore.getState().openTab('/a.ts')
      const s = useWorkspaceStore.getState()
      expect(s.openTabs).toHaveLength(1)
      expect(s.openTabs[0]).toEqual({ path: '/a.ts', viewState: null, dirty: false })
      expect(s.activeTabPath).toBe('/a.ts')
    })

    it('re-opening an open tab focuses it without duplicating', () => {
      const { openTab } = useWorkspaceStore.getState()
      openTab('/a.ts')
      openTab('/b.ts')
      openTab('/a.ts')
      const s = useWorkspaceStore.getState()
      expect(s.openTabs.map((t) => t.path)).toEqual(['/a.ts', '/b.ts'])
      expect(s.activeTabPath).toBe('/a.ts')
    })

    it('closing the active tab moves focus to the right-hand neighbour', () => {
      const { openTab, setActive, closeTab } = useWorkspaceStore.getState()
      openTab('/a.ts')
      openTab('/b.ts')
      openTab('/c.ts')
      setActive('/b.ts')
      closeTab('/b.ts')
      const s = useWorkspaceStore.getState()
      expect(s.openTabs.map((t) => t.path)).toEqual(['/a.ts', '/c.ts'])
      expect(s.activeTabPath).toBe('/c.ts')
    })

    it('closing the last tab falls back to the left-hand neighbour', () => {
      const { openTab, closeTab } = useWorkspaceStore.getState()
      openTab('/a.ts')
      openTab('/b.ts')
      // `/b.ts` is already the active tab.
      closeTab('/b.ts')
      const s = useWorkspaceStore.getState()
      expect(s.activeTabPath).toBe('/a.ts')
    })

    it('closing the only open tab clears the active path', () => {
      const { openTab, closeTab } = useWorkspaceStore.getState()
      openTab('/a.ts')
      closeTab('/a.ts')
      const s = useWorkspaceStore.getState()
      expect(s.openTabs).toEqual([])
      expect(s.activeTabPath).toBeNull()
    })

    it('closing a tab drops its cached contents and dirty flag', () => {
      const { openTab, updateContent, closeTab } = useWorkspaceStore.getState()
      openTab('/a.ts')
      updateContent('/a.ts', 'const x = 1')
      expect(useWorkspaceStore.getState().contentsCache['/a.ts']).toBe('const x = 1')
      closeTab('/a.ts')
      const s = useWorkspaceStore.getState()
      expect(s.contentsCache['/a.ts']).toBeUndefined()
      expect(s.dirtyMap['/a.ts']).toBeUndefined()
    })

    it('closeTab is a no-op for an unknown path', () => {
      const { openTab, closeTab } = useWorkspaceStore.getState()
      openTab('/a.ts')
      closeTab('/never-opened.ts')
      const s = useWorkspaceStore.getState()
      expect(s.openTabs.map((t) => t.path)).toEqual(['/a.ts'])
      expect(s.activeTabPath).toBe('/a.ts')
    })
  })

  describe('markDirty', () => {
    it('sets and clears the dirty flag on the tab and in dirtyMap', () => {
      const { openTab, markDirty } = useWorkspaceStore.getState()
      openTab('/a.ts')
      markDirty('/a.ts', true)
      let s = useWorkspaceStore.getState()
      expect(s.openTabs[0].dirty).toBe(true)
      expect(s.dirtyMap['/a.ts']).toBe(true)

      markDirty('/a.ts', false)
      s = useWorkspaceStore.getState()
      expect(s.openTabs[0].dirty).toBe(false)
      expect(s.dirtyMap['/a.ts']).toBe(false)
    })

    it('is a no-op for paths that are not open', () => {
      const { markDirty } = useWorkspaceStore.getState()
      markDirty('/ghost.ts', true)
      const s = useWorkspaceStore.getState()
      expect(s.dirtyMap['/ghost.ts']).toBeUndefined()
    })
  })

  describe('setActive', () => {
    it('flips activeTabPath to a different open tab', () => {
      const { openTab, setActive } = useWorkspaceStore.getState()
      openTab('/a.ts')
      openTab('/b.ts')
      // After openTab, active is `/b.ts`.
      setActive('/a.ts')
      expect(useWorkspaceStore.getState().activeTabPath).toBe('/a.ts')
      setActive('/b.ts')
      expect(useWorkspaceStore.getState().activeTabPath).toBe('/b.ts')
    })

    it('clears focus when called with null', () => {
      const { openTab, setActive } = useWorkspaceStore.getState()
      openTab('/a.ts')
      setActive(null)
      expect(useWorkspaceStore.getState().activeTabPath).toBeNull()
    })

    it('is a no-op for paths that are not open', () => {
      const { openTab, setActive } = useWorkspaceStore.getState()
      openTab('/a.ts')
      setActive('/never-opened.ts')
      expect(useWorkspaceStore.getState().activeTabPath).toBe('/a.ts')
    })
  })

  describe('updateContent', () => {
    it('caches new content and marks the tab dirty', () => {
      const { openTab, updateContent } = useWorkspaceStore.getState()
      openTab('/a.ts')
      updateContent('/a.ts', 'new body')
      const s = useWorkspaceStore.getState()
      expect(s.contentsCache['/a.ts']).toBe('new body')
      expect(s.openTabs[0].dirty).toBe(true)
      expect(s.dirtyMap['/a.ts']).toBe(true)
    })

    it('still caches content for paths without an open tab', () => {
      const { updateContent } = useWorkspaceStore.getState()
      updateContent('/preloaded.ts', 'body')
      const s = useWorkspaceStore.getState()
      expect(s.contentsCache['/preloaded.ts']).toBe('body')
      expect(s.dirtyMap['/preloaded.ts']).toBeUndefined()
    })
  })

  describe('setViewState', () => {
    it('stores Monaco view state on the open tab', () => {
      const { openTab, setViewState } = useWorkspaceStore.getState()
      openTab('/a.ts')
      const vs = { cursorState: [], viewState: { scrollTop: 120 } }
      setViewState('/a.ts', vs)
      expect(useWorkspaceStore.getState().openTabs[0].viewState).toBe(vs)
    })
  })

  describe('toggleExpand', () => {
    it('adds and removes paths from expandedSet', () => {
      const { toggleExpand } = useWorkspaceStore.getState()
      toggleExpand('/repo/src')
      expect(useWorkspaceStore.getState().expandedSet.has('/repo/src')).toBe(true)
      toggleExpand('/repo/src')
      expect(useWorkspaceStore.getState().expandedSet.has('/repo/src')).toBe(false)
    })
  })

  describe('hydrateFromSession', () => {
    it('restores openTabs, activeTabPath, and expandedSet from snapshot', () => {
      const snapshot: ProjectSessionSnapshot = {
        openTabs: [
          { path: '/a.ts', viewState: null, dirty: false },
          { path: '/b.ts', viewState: { foo: 1 }, dirty: true },
        ],
        activeTabPath: '/b.ts',
        expandedPaths: ['/repo', '/repo/src'],
      }

      useWorkspaceStore.getState().hydrateFromSession(snapshot)
      const s = useWorkspaceStore.getState()

      expect(s.openTabs.map((t) => t.path)).toEqual(['/a.ts', '/b.ts'])
      expect(s.openTabs[1].dirty).toBe(true)
      expect(s.openTabs[1].viewState).toEqual({ foo: 1 })
      expect(s.activeTabPath).toBe('/b.ts')
      expect(s.expandedSet.has('/repo')).toBe(true)
      expect(s.expandedSet.has('/repo/src')).toBe(true)
      expect(s.dirtyMap['/b.ts']).toBe(true)
      expect(s.dirtyMap['/a.ts']).toBeUndefined()
    })

    it('replaces (does not merge) the previous session state', () => {
      const { openTab, toggleExpand, hydrateFromSession } = useWorkspaceStore.getState()
      openTab('/before.ts')
      toggleExpand('/stale-folder')

      hydrateFromSession({
        openTabs: [{ path: '/after.ts', viewState: null, dirty: false }],
        activeTabPath: '/after.ts',
        expandedPaths: ['/fresh-folder'],
      })

      const s = useWorkspaceStore.getState()
      expect(s.openTabs.map((t) => t.path)).toEqual(['/after.ts'])
      expect(s.expandedSet.has('/stale-folder')).toBe(false)
      expect(s.expandedSet.has('/fresh-folder')).toBe(true)
    })

    it('copies tabs so mutating the snapshot afterwards does not bleed in', () => {
      const snapshot: ProjectSessionSnapshot = {
        openTabs: [{ path: '/a.ts', viewState: null, dirty: false }],
        activeTabPath: '/a.ts',
        expandedPaths: [],
      }
      useWorkspaceStore.getState().hydrateFromSession(snapshot)
      // External mutation must not affect store state.
      snapshot.openTabs[0].dirty = true
      expect(useWorkspaceStore.getState().openTabs[0].dirty).toBe(false)
    })
  })

  describe('setProject', () => {
    it('replaces project + derived repos and clears tab / explorer state', () => {
      const { openTab, toggleExpand, setProject } = useWorkspaceStore.getState()
      openTab('/old.ts')
      toggleExpand('/old-folder')

      const project = mkProject('p2')
      setProject(project)

      const s = useWorkspaceStore.getState()
      expect(s.project).toEqual(project)
      expect(s.repos).toEqual(project.repos)
      expect(s.openTabs).toEqual([])
      expect(s.activeTabPath).toBeNull()
      expect(s.contentsCache).toEqual({})
      expect(s.dirtyMap).toEqual({})
      expect(s.expandedSet.size).toBe(0)
    })

    it('returns to Welcome on null', () => {
      const { setProject } = useWorkspaceStore.getState()
      setProject(mkProject())
      setProject(null)
      const s = useWorkspaceStore.getState()
      expect(s.project).toBeNull()
      expect(s.repos).toEqual([])
    })
  })

  describe('loadContent', () => {
    it('caches content without marking the tab dirty', () => {
      const { openTab, loadContent } = useWorkspaceStore.getState()
      openTab('/a.ts')
      loadContent('/a.ts', 'from disk')
      const s = useWorkspaceStore.getState()
      expect(s.contentsCache['/a.ts']).toBe('from disk')
      expect(s.openTabs[0].dirty).toBe(false)
      expect(s.dirtyMap['/a.ts']).toBeUndefined()
    })

    it('seeds contents for paths with no open tab', () => {
      useWorkspaceStore.getState().loadContent('/preloaded.ts', 'body')
      expect(useWorkspaceStore.getState().contentsCache['/preloaded.ts']).toBe('body')
    })
  })

  describe('setExpanded', () => {
    it('adds and removes paths idempotently', () => {
      const { setExpanded } = useWorkspaceStore.getState()
      setExpanded('/repo/src', true)
      expect(useWorkspaceStore.getState().expandedSet.has('/repo/src')).toBe(true)
      // setting again is a no-op (same reference is fine; we just check no throw)
      setExpanded('/repo/src', true)
      expect(useWorkspaceStore.getState().expandedSet.has('/repo/src')).toBe(true)
      setExpanded('/repo/src', false)
      expect(useWorkspaceStore.getState().expandedSet.has('/repo/src')).toBe(false)
    })
  })

  describe('cacheChildren + invalidateChildren', () => {
    it('stores and drops a listing keyed by absolute path', () => {
      const { cacheChildren, invalidateChildren } = useWorkspaceStore.getState()
      const entries = [mkEntry('/repo/src', true), mkEntry('/repo/index.ts')]
      cacheChildren('/repo', entries)
      expect(useWorkspaceStore.getState().childrenCache['/repo']).toEqual(entries)
      invalidateChildren('/repo')
      expect(useWorkspaceStore.getState().childrenCache['/repo']).toBeUndefined()
    })

    it('invalidateChildren is a no-op for unknown paths', () => {
      const before = useWorkspaceStore.getState().childrenCache
      useWorkspaceStore.getState().invalidateChildren('/never-cached')
      expect(useWorkspaceStore.getState().childrenCache).toBe(before)
    })
  })

  describe('setSelectedExplorerPath', () => {
    it('tracks the focused tree node', () => {
      const { setSelectedExplorerPath } = useWorkspaceStore.getState()
      setSelectedExplorerPath('/repo/src/a.ts')
      expect(useWorkspaceStore.getState().selectedExplorerPath).toBe('/repo/src/a.ts')
      setSelectedExplorerPath(null)
      expect(useWorkspaceStore.getState().selectedExplorerPath).toBeNull()
    })
  })

  describe('renamePath', () => {
    it('rewrites an open tab when its file is renamed', () => {
      const { openTab, updateContent, renamePath } = useWorkspaceStore.getState()
      openTab('/repo/old.ts')
      updateContent('/repo/old.ts', 'body')
      renamePath('/repo/old.ts', '/repo/new.ts')

      const s = useWorkspaceStore.getState()
      expect(s.openTabs.map((t) => t.path)).toEqual(['/repo/new.ts'])
      expect(s.activeTabPath).toBe('/repo/new.ts')
      expect(s.contentsCache['/repo/new.ts']).toBe('body')
      expect(s.contentsCache['/repo/old.ts']).toBeUndefined()
      expect(s.dirtyMap['/repo/new.ts']).toBe(true)
      expect(s.dirtyMap['/repo/old.ts']).toBeUndefined()
    })

    it('rewrites descendants when a directory is renamed', () => {
      const { openTab, cacheChildren, setExpanded, renamePath } = useWorkspaceStore.getState()
      openTab('/repo/old/a.ts')
      openTab('/repo/old/sub/b.ts')
      setExpanded('/repo/old', true)
      setExpanded('/repo/old/sub', true)
      cacheChildren('/repo/old', [mkEntry('/repo/old/a.ts'), mkEntry('/repo/old/sub', true)])

      renamePath('/repo/old', '/repo/new')

      const s = useWorkspaceStore.getState()
      expect(s.openTabs.map((t) => t.path)).toEqual([
        '/repo/new/a.ts',
        '/repo/new/sub/b.ts',
      ])
      expect(s.activeTabPath).toBe('/repo/new/sub/b.ts')
      expect(s.expandedSet.has('/repo/new')).toBe(true)
      expect(s.expandedSet.has('/repo/new/sub')).toBe(true)
      expect(s.expandedSet.has('/repo/old')).toBe(false)
      expect(s.childrenCache['/repo/new']?.map((e) => e.path)).toEqual([
        '/repo/new/a.ts',
        '/repo/new/sub',
      ])
      expect(s.childrenCache['/repo/old']).toBeUndefined()
    })

    it('leaves unrelated paths untouched', () => {
      const { openTab, renamePath } = useWorkspaceStore.getState()
      openTab('/other/keep.ts')
      openTab('/repo/foo.ts')
      renamePath('/repo/foo.ts', '/repo/bar.ts')
      const s = useWorkspaceStore.getState()
      expect(s.openTabs.map((t) => t.path).sort()).toEqual([
        '/other/keep.ts',
        '/repo/bar.ts',
      ])
    })

    it('does not falsely rewrite a sibling that shares the prefix', () => {
      // `/repo/foo` is renamed; `/repo/foobar.ts` must NOT be touched.
      const { openTab, renamePath } = useWorkspaceStore.getState()
      openTab('/repo/foobar.ts')
      openTab('/repo/foo/a.ts')
      renamePath('/repo/foo', '/repo/zzz')
      const s = useWorkspaceStore.getState()
      expect(s.openTabs.map((t) => t.path).sort()).toEqual([
        '/repo/foobar.ts',
        '/repo/zzz/a.ts',
      ])
    })

    it('rewrites the selectedExplorerPath when it falls under the rename', () => {
      const { setSelectedExplorerPath, renamePath } = useWorkspaceStore.getState()
      setSelectedExplorerPath('/repo/old/inner/c.ts')
      renamePath('/repo/old', '/repo/new')
      expect(useWorkspaceStore.getState().selectedExplorerPath).toBe(
        '/repo/new/inner/c.ts',
      )
    })
  })

  describe('setProject clears explorer caches', () => {
    it('drops childrenCache and selectedExplorerPath on project switch', () => {
      const { cacheChildren, setSelectedExplorerPath, setProject } =
        useWorkspaceStore.getState()
      cacheChildren('/old', [mkEntry('/old/a.ts')])
      setSelectedExplorerPath('/old/a.ts')
      setProject(mkProject('next'))
      const s = useWorkspaceStore.getState()
      expect(s.childrenCache).toEqual({})
      expect(s.selectedExplorerPath).toBeNull()
    })
  })

  describe('pushRecent', () => {
    it('delegates to the LRU helper — caps at 10 and dedups by id', () => {
      const { pushRecent } = useWorkspaceStore.getState()

      for (let i = 0; i < 12; i++) pushRecent(mkRecent(`p${i}`))
      let s = useWorkspaceStore.getState()
      expect(s.recents).toHaveLength(10)
      expect(s.recents[0].id).toBe('p11')

      // Re-push an existing id; should move it to the front, not grow the list.
      pushRecent({ ...mkRecent('p5'), lastOpenedAt: 999 })
      s = useWorkspaceStore.getState()
      expect(s.recents).toHaveLength(10)
      expect(s.recents[0].id).toBe('p5')
      expect(s.recents[0].lastOpenedAt).toBe(999)
    })
  })
})
