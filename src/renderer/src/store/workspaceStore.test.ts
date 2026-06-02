import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DirEntry,
  InspectedFolder,
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
  repos: [{ name: id, path: `/projects/${id}`, isGitRepo: true }],
  createdAt: 0,
  lastOpenedAt: 0,
})

const mkRecent = (id: string): RecentEntry => ({
  id,
  name: id,
  repoCount: 1,
  lastOpenedAt: 0,
})

/**
 * Install a fake `window.hive` bridge with the supplied `inspectFolder`.
 * `addRepoToProject` is the only store action that reaches across the bridge.
 */
function installInspectFolder(
  impl: (path: string) => Promise<InspectedFolder>,
): void {
  ;(globalThis as unknown as {
    window: { hive: { project: { inspectFolder: typeof impl } } }
  }).window = { hive: { project: { inspectFolder: impl } } }
}

function uninstallHive(): void {
  ;(globalThis as unknown as { window: unknown }).window = {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workspaceStore', () => {
  beforeEach(resetStore)
  afterEach(() => {
    uninstallHive()
    vi.restoreAllMocks()
  })

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

  describe('createProject', () => {
    it('creates a fresh project, sets it active, and pushes a recent', () => {
      const before = Date.now()
      const project = useWorkspaceStore.getState().createProject('octopus')
      const after = Date.now()

      expect(project.name).toBe('octopus')
      expect(project.repos).toEqual([])
      expect(project.createdAt).toBeGreaterThanOrEqual(before)
      expect(project.createdAt).toBeLessThanOrEqual(after)
      expect(project.lastOpenedAt).toBe(project.createdAt)
      expect(project.id).toMatch(/.+/)

      const s = useWorkspaceStore.getState()
      expect(s.project).toEqual(project)
      expect(s.repos).toEqual([])
      expect(s.recents).toHaveLength(1)
      expect(s.recents[0].id).toBe(project.id)
      expect(s.recents[0].name).toBe('octopus')
      expect(s.recents[0].repoCount).toBe(0)
    })

    it('trims whitespace around the name', () => {
      const project = useWorkspaceStore.getState().createProject('   acme  ')
      expect(project.name).toBe('acme')
    })

    it('throws when the name is empty after trimming', () => {
      const { createProject } = useWorkspaceStore.getState()
      expect(() => createProject('   ')).toThrow()
      expect(() => createProject('')).toThrow()
    })

    it('clears tab / explorer state', () => {
      const { openTab, toggleExpand, createProject } = useWorkspaceStore.getState()
      openTab('/old.ts')
      toggleExpand('/old')
      createProject('fresh')
      const s = useWorkspaceStore.getState()
      expect(s.openTabs).toEqual([])
      expect(s.expandedSet.size).toBe(0)
    })
  })

  describe('addRepoToProject', () => {
    it('appends the inspected folder as a repo', async () => {
      useWorkspaceStore.getState().createProject('demo')
      installInspectFolder(async (path) => ({
        path,
        name: 'web',
        isGitRepo: true,
      }))

      await useWorkspaceStore.getState().addRepoToProject('/Users/me/demo/web')

      const s = useWorkspaceStore.getState()
      expect(s.project?.repos).toEqual([
        { name: 'web', path: '/Users/me/demo/web', isGitRepo: true },
      ])
      expect(s.repos).toEqual(s.project?.repos)
      expect(s.recents[0].repoCount).toBe(1)
    })

    it('is a no-op when no project is active', async () => {
      const inspect = vi.fn()
      installInspectFolder(inspect as unknown as (p: string) => Promise<InspectedFolder>)
      await useWorkspaceStore.getState().addRepoToProject('/Users/me/something')
      expect(inspect).not.toHaveBeenCalled()
      expect(useWorkspaceStore.getState().project).toBeNull()
    })

    it('is a no-op when the repo path is already present', async () => {
      useWorkspaceStore.getState().createProject('demo')
      const inspect = vi
        .fn<(p: string) => Promise<InspectedFolder>>()
        .mockResolvedValue({
          path: '/Users/me/demo/web',
          name: 'web',
          isGitRepo: true,
        })
      installInspectFolder(inspect)

      await useWorkspaceStore.getState().addRepoToProject('/Users/me/demo/web')
      await useWorkspaceStore.getState().addRepoToProject('/Users/me/demo/web')

      // Short-circuit at the top of the action means inspectFolder shouldn't
      // even be called the second time.
      expect(inspect).toHaveBeenCalledTimes(1)
      expect(useWorkspaceStore.getState().project?.repos).toHaveLength(1)
    })
  })

  describe('removeRepoFromProject', () => {
    it('removes the repo with the matching path', async () => {
      useWorkspaceStore.getState().createProject('demo')
      installInspectFolder(async (path) => ({
        path,
        name: path.split('/').pop() ?? '',
        isGitRepo: true,
      }))

      await useWorkspaceStore.getState().addRepoToProject('/a/web')
      await useWorkspaceStore.getState().addRepoToProject('/a/api')

      useWorkspaceStore.getState().removeRepoFromProject('/a/web')
      const s = useWorkspaceStore.getState()
      expect(s.project?.repos.map((r) => r.path)).toEqual(['/a/api'])
      expect(s.repos.map((r) => r.path)).toEqual(['/a/api'])
    })

    it('is a no-op for an unknown path', () => {
      useWorkspaceStore.getState().createProject('demo')
      useWorkspaceStore.getState().removeRepoFromProject('/never-added')
      expect(useWorkspaceStore.getState().project?.repos).toEqual([])
    })
  })

  describe('renameProject', () => {
    it('renames the active project and updates the matching recents entry', () => {
      const p = useWorkspaceStore.getState().createProject('old name')
      useWorkspaceStore.getState().renameProject(p.id, 'new name')
      const s = useWorkspaceStore.getState()
      expect(s.project?.name).toBe('new name')
      expect(s.recents[0].name).toBe('new name')
    })

    it('updates only the recents entry when the id is not the active project', () => {
      // Two projects: create p1, then p2 — p2 ends up active.
      useWorkspaceStore.getState().createProject('one')
      const p1Id = useWorkspaceStore.getState().recents[0].id
      useWorkspaceStore.getState().createProject('two')

      useWorkspaceStore.getState().renameProject(p1Id, 'one renamed')
      const s = useWorkspaceStore.getState()
      expect(s.project?.name).toBe('two')
      expect(s.recents.find((r) => r.id === p1Id)?.name).toBe('one renamed')
    })

    it('no-ops on an empty trimmed name', () => {
      const p = useWorkspaceStore.getState().createProject('keep')
      useWorkspaceStore.getState().renameProject(p.id, '   ')
      expect(useWorkspaceStore.getState().project?.name).toBe('keep')
    })
  })

  describe('closeProject', () => {
    it('clears the active project and all editor state', () => {
      useWorkspaceStore.getState().createProject('demo')
      useWorkspaceStore.getState().openTab('/a.ts')

      useWorkspaceStore.getState().closeProject()
      const s = useWorkspaceStore.getState()
      expect(s.project).toBeNull()
      expect(s.repos).toEqual([])
      expect(s.openTabs).toEqual([])
      expect(s.activeTabPath).toBeNull()
    })

    it('keeps recents intact so the user can pick the project back up', () => {
      useWorkspaceStore.getState().createProject('demo')
      useWorkspaceStore.getState().closeProject()
      expect(useWorkspaceStore.getState().recents).toHaveLength(1)
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
