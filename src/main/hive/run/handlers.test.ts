import { describe, it, expect, vi } from 'vitest';

// `electron` is a native runtime — stub it so the module is importable in the
// Node-only vitest environment. These tests call `runStory` directly and never
// touch `registerHiveRunHandlers`, but the module-level import of `ipcMain`
// still needs `electron` to resolve.
vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
  },
}));

import { runStory, type RunDeps } from './handlers';
import type { HiveStory } from '../../../types/hive';

const story: HiveStory = {
  id: 'AUTH-3', title: 'Add login', status: 'pending', role: 'senior', points: 3,
  team: 'web', dependsOn: [], acceptanceCriteria: ['a'], createdAt: 't', updatedAt: 't',
  body: 'do it',
};

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    getWorkspacePath: () => '/ws',
    getRepoPath: () => '/repo',
    getStory: vi.fn(async () => story),
    readRoleOverride: vi.fn(async () => null),
    createWorktree: vi.fn(async () => ({ git: {} as never, path: '/ws/.hive/worktrees/AUTH-3', branch: 'feat/AUTH-3', baseSha: 'abc' })),
    hasNewCommit: vi.fn(async () => true),
    writeRunStart: vi.fn(async () => {}),
    writeRunFinish: vi.fn(async () => {}),
    runner: {
      isBusy: () => false,
      start: vi.fn((_spec, ev) => { ev.onStatus('running'); ev.onExit({ code: 0, signal: null }); }),
      stop: vi.fn(async () => {}),
    },
    send: vi.fn(),
    appendRunLog: vi.fn(),
    now: () => 't0',
    newRunId: () => 'run_1',
    ...over,
  };
}

describe('runStory', () => {
  it('runs the happy path: worktree → start-write → runner → commit → finish(success)', async () => {
    const d = deps();
    await runStory(d, 'AUTH-3');
    expect(d.createWorktree).toHaveBeenCalled();
    expect(d.writeRunStart).toHaveBeenCalled();
    expect(d.runner.start).toHaveBeenCalled();
    expect(d.hasNewCommit).toHaveBeenCalled();
    expect(d.writeRunFinish).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: 'success' } }));
  });

  it('exit 0 with no commit → finish(no-commit)', async () => {
    const d = deps({ hasNewCommit: vi.fn(async () => false) });
    await runStory(d, 'AUTH-3');
    expect(d.writeRunFinish).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: 'no-commit' } }));
  });

  it('non-zero exit → finish(failure)', async () => {
    const d = deps({
      runner: {
        isBusy: () => false,
        start: vi.fn((_spec, ev) => { ev.onStatus('running'); ev.onExit({ code: 1, signal: null }); }),
        stop: vi.fn(async () => {}),
      },
    });
    await runStory(d, 'AUTH-3');
    expect(d.writeRunFinish).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: 'failure' } }));
  });

  it('signal (stopped) → finish(interrupted)', async () => {
    const d = deps({
      runner: {
        isBusy: () => false,
        start: vi.fn((_spec, ev) => { ev.onStatus('running'); ev.onExit({ code: null, signal: 'SIGTERM' }); }),
        stop: vi.fn(async () => {}),
      },
    });
    await runStory(d, 'AUTH-3');
    expect(d.writeRunFinish).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: 'interrupted' } }));
  });

  it('throws when the runner is busy', async () => {
    const d = deps({ runner: { isBusy: () => true, start: vi.fn(), stop: vi.fn(async () => {}) } });
    await expect(runStory(d, 'AUTH-3')).rejects.toThrow(/busy/i);
  });

  it('rejects a concurrent runStory while one is in flight', async () => {
    let release: (() => void) | null = null;
    const d = deps({
      runner: {
        isBusy: () => false,
        start: vi.fn((_spec, ev) => { ev.onStatus('running'); release = () => ev.onExit({ code: 0, signal: null }); }),
        stop: vi.fn(async () => {}),
      },
    });
    const first = runStory(d, 'AUTH-3');           // starts, awaits onExit (deferred)
    await Promise.resolve();                        // let the start() run
    await expect(runStory(d, 'AUTH-3')).rejects.toThrow(/busy/i);
    release?.();                                    // let the first finish
    await first;
  });

  it('throws when the story is missing', async () => {
    const d = deps({ getStory: vi.fn(async () => null) });
    await expect(runStory(d, 'NOPE')).rejects.toThrow(/not found/i);
  });
});
