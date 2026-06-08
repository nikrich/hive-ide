import { describe, it, expect, vi } from 'vitest';

import { createWorktree, hasNewCommit, type GitLike } from './worktree';

function fakeGit(map: Record<string, { stdout: string; code: number }>): GitLike {
  return {
    run: vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(' ');
      const hit = Object.entries(map).find(([k]) => key.startsWith(k));
      return hit ? { stderr: '', ...hit[1] } : { stdout: '', stderr: '', code: 0 };
    }),
  };
}

describe('createWorktree', () => {
  it('resolves the default branch, captures baseSha, and adds the worktree', async () => {
    const git = fakeGit({
      'symbolic-ref': { stdout: 'main\n', code: 0 },
      'rev-parse': { stdout: 'abc123\n', code: 0 },
      'worktree add': { stdout: '', code: 0 },
    });
    const wt = await createWorktree({
      git, repoPath: '/repo', workspacePath: '/ws', storyId: 'AUTH-3', branch: 'feat/AUTH-3',
    });
    expect(wt.path).toBe('/ws/.hive/worktrees/AUTH-3');
    expect(wt.branch).toBe('feat/AUTH-3');
    expect(wt.baseSha).toBe('abc123');
    expect(git.run).toHaveBeenCalledWith(
      '/repo',
      expect.arrayContaining(['worktree', 'add', '-b', 'feat/AUTH-3', '/ws/.hive/worktrees/AUTH-3', 'abc123']),
    );
  });

  it('throws when worktree add fails (non-zero code)', async () => {
    const git = fakeGit({
      'symbolic-ref': { stdout: 'main\n', code: 0 },
      'rev-parse': { stdout: 'abc\n', code: 0 },
      'worktree add': { stdout: '', code: 128 },
    });
    await expect(createWorktree({
      git, repoPath: '/repo', workspacePath: '/ws', storyId: 'X', branch: 'feat/X',
    })).rejects.toThrow();
  });

  it('cleans up a prior worktree + branch before adding (idempotent re-run)', async () => {
    const git = fakeGit({
      'symbolic-ref': { stdout: 'main\n', code: 0 },
      'rev-parse': { stdout: 'abc123\n', code: 0 },
      'worktree add': { stdout: '', code: 0 },
    });
    await createWorktree({
      git, repoPath: '/repo', workspacePath: '/ws', storyId: 'AUTH-3', branch: 'feat/AUTH-3',
    });
    const calls = (git.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as string[]).join(' '));
    // Best-effort cleanup is issued before the add.
    expect(calls).toContain('worktree remove --force /ws/.hive/worktrees/AUTH-3');
    expect(calls).toContain('worktree prune');
    expect(calls).toContain('branch -D feat/AUTH-3');
    const removeIdx = calls.findIndex((c) => c.startsWith('worktree remove'));
    const addIdx = calls.findIndex((c) => c.startsWith('worktree add'));
    expect(removeIdx).toBeLessThan(addIdx);
  });

  it('still adds the worktree when there is nothing to clean up (cleanup returns non-zero)', async () => {
    const git = fakeGit({
      'symbolic-ref': { stdout: 'main\n', code: 0 },
      'rev-parse': { stdout: 'abc\n', code: 0 },
      'worktree remove': { stdout: '', code: 128 }, // nothing registered → git errors, ignored
      'branch -D': { stdout: '', code: 1 }, // branch absent → git errors, ignored
      'worktree add': { stdout: '', code: 0 },
    });
    const wt = await createWorktree({
      git, repoPath: '/repo', workspacePath: '/ws', storyId: 'X', branch: 'feat/X',
    });
    expect(wt.path).toBe('/ws/.hive/worktrees/X');
  });
});

describe('hasNewCommit', () => {
  it('true when rev-list count > 0', async () => {
    const git = fakeGit({ 'rev-list': { stdout: '2\n', code: 0 } });
    expect(await hasNewCommit({ git, path: '/wt', branch: 'b', baseSha: 'abc' })).toBe(true);
  });
  it('false when rev-list count is 0', async () => {
    const git = fakeGit({ 'rev-list': { stdout: '0\n', code: 0 } });
    expect(await hasNewCommit({ git, path: '/wt', branch: 'b', baseSha: 'abc' })).toBe(false);
  });
});
