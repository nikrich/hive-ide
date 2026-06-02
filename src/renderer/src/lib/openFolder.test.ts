import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'

import { openFolderFlow } from './openFolder'

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

interface HiveLike {
  project: {
    openDialog: () => Promise<{ canceled: boolean; path?: string }>
    detect: (path: string) => Promise<Project>
  }
}

/**
 * Install a fake `window.hive` bridge for the test. The real bridge is
 * injected by the preload script at runtime; tests run in plain Node, so
 * we patch the global `globalThis` directly.
 */
function installHive(hive: HiveLike): void {
  // `as unknown` avoids dragging the full HiveBridge surface into each test;
  // the helper only touches `project.openDialog` and `project.detect`.
  ;(globalThis as unknown as { window: { hive: HiveLike } }).window = { hive }
}

/** Restore an empty `window` so subsequent tests can install their own fake. */
function uninstallHive(): void {
  ;(globalThis as unknown as { window: unknown }).window = {}
}

const mkProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  name: 'demo',
  rootPath: '/Users/me/demo',
  source: 'auto-detected',
  repos: [
    { name: 'web', path: '/Users/me/demo/web', isGitRepo: true },
    { name: 'api', path: '/Users/me/demo/api', isGitRepo: true },
  ],
  lastOpenedAt: 0,
  ...overrides,
})

beforeEach(() => {
  useWorkspaceStore.setState({
    project: null,
    repos: [],
    openTabs: [],
    activeTabPath: null,
    contentsCache: {},
    dirtyMap: {},
    expandedSet: new Set<string>(),
    recents: [],
  })
})

afterEach(() => {
  uninstallHive()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('openFolderFlow', () => {
  it('returns null when the user cancels the dialog', async () => {
    const detect = vi.fn()
    installHive({
      project: {
        openDialog: () => Promise.resolve({ canceled: true }),
        detect,
      },
    })

    const result = await openFolderFlow()

    expect(result).toBeNull()
    expect(detect).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().project).toBeNull()
    expect(useWorkspaceStore.getState().recents).toEqual([])
  })

  it('returns null when openDialog resolves without a path (defensive)', async () => {
    installHive({
      project: {
        openDialog: () => Promise.resolve({ canceled: false }),
        detect: vi.fn(),
      },
    })

    const result = await openFolderFlow()
    expect(result).toBeNull()
  })

  it('runs detect, sets the project, and pushes a recent on success', async () => {
    const project = mkProject({ id: 'sha-xyz', name: 'octopus' })
    const detect = vi.fn().mockResolvedValue(project)

    installHive({
      project: {
        openDialog: () => Promise.resolve({ canceled: false, path: project.rootPath }),
        detect,
      },
    })

    const before = Date.now()
    const result = await openFolderFlow()
    const after = Date.now()

    expect(result).toBe('sha-xyz')
    expect(detect).toHaveBeenCalledWith(project.rootPath)

    const s = useWorkspaceStore.getState()
    expect(s.project).toEqual(project)
    expect(s.repos).toEqual(project.repos)

    expect(s.recents).toHaveLength(1)
    expect(s.recents[0].id).toBe('sha-xyz')
    expect(s.recents[0].name).toBe('octopus')
    expect(s.recents[0].rootPath).toBe(project.rootPath)
    expect(s.recents[0].source).toBe('auto-detected')
    expect(s.recents[0].repoCount).toBe(2)
    expect(s.recents[0].lastOpenedAt).toBeGreaterThanOrEqual(before)
    expect(s.recents[0].lastOpenedAt).toBeLessThanOrEqual(after)
  })

  it('moves an existing recent to the front when re-opened', async () => {
    const project = mkProject({ id: 'sha-xyz' })

    useWorkspaceStore.setState({
      recents: [
        {
          id: 'sha-xyz',
          name: 'demo',
          rootPath: project.rootPath,
          source: 'auto-detected',
          repoCount: 2,
          lastOpenedAt: 1,
        },
        {
          id: 'sha-abc',
          name: 'other',
          rootPath: '/Users/me/other',
          source: 'single-repo',
          repoCount: 1,
          lastOpenedAt: 2,
        },
      ],
    })

    installHive({
      project: {
        openDialog: () => Promise.resolve({ canceled: false, path: project.rootPath }),
        detect: () => Promise.resolve(project),
      },
    })

    await openFolderFlow()

    const s = useWorkspaceStore.getState()
    expect(s.recents.map((r) => r.id)).toEqual(['sha-xyz', 'sha-abc'])
    // The re-opened entry got a fresh timestamp, not the stale `1`.
    expect(s.recents[0].lastOpenedAt).toBeGreaterThan(1)
  })
})
