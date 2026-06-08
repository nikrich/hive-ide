/**
 * Git worktree lifecycle for a worker run (slice 2a). Thin wrapper over a
 * GitRunner-shaped dependency so it's testable without a real repo.
 */

import { join } from 'node:path';

/** The slice of GitRunner we use (injected for tests). */
export interface GitLike {
  run(
    cwd: string,
    args: string[],
    opts?: { maxBufferMB?: number },
  ): Promise<{ stdout: string; stderr: string; code: number | null }>;
}

export interface Worktree {
  /** GitLike used to operate on this worktree. */
  git: GitLike;
  /** Absolute worktree path. */
  path: string;
  branch: string;
  /** Default-branch sha the worktree was cut from (commit-detection base). */
  baseSha: string;
}

/** Resolve the repo's default branch name (e.g. `main`). */
// Slice 2a assumes the repo's checked-out branch is the base to cut from.
async function defaultBranch(git: GitLike, repoPath: string): Promise<string> {
  const res = await git.run(repoPath, ['symbolic-ref', '--short', 'HEAD']);
  const name = res.stdout.trim();
  return name !== '' ? name : 'main';
}

export async function createWorktree(opts: {
  git: GitLike;
  repoPath: string;
  workspacePath: string;
  storyId: string;
  branch: string;
}): Promise<Worktree> {
  const { git, repoPath, workspacePath, storyId, branch } = opts;
  const base = await defaultBranch(git, repoPath);
  const shaRes = await git.run(repoPath, ['rev-parse', base]);
  const baseSha = shaRes.stdout.trim();
  const path = join(workspacePath, '.hive', 'worktrees', storyId);

  // Idempotent re-run: clean up any worktree + branch left by a prior run of
  // this story so `worktree add -b` doesn't fail with "already exists". All
  // best-effort — each command may fail (nothing to remove / branch absent),
  // and a non-zero exit is ignored. NOTE: re-running discards the previous
  // worktree's commit, which is the intended "redo this story" semantic (the
  // feature branch was never merged). The worktree must be removed BEFORE the
  // branch (the branch is checked out inside it).
  await git.run(repoPath, ['worktree', 'remove', '--force', path]);
  await git.run(repoPath, ['worktree', 'prune']);
  await git.run(repoPath, ['branch', '-D', branch]);

  const add = await git.run(repoPath, ['worktree', 'add', '-b', branch, path, baseSha]);
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr.trim() || `exit ${add.code}`}`);
  }
  return { git, path, branch, baseSha };
}

/** True if the worktree has ≥1 commit beyond baseSha. */
export async function hasNewCommit(wt: Worktree): Promise<boolean> {
  const res = await wt.git.run(wt.path, ['rev-list', '--count', `${wt.baseSha}..HEAD`]);
  return (parseInt(res.stdout.trim(), 10) || 0) > 0;
}

/** Remove the worktree dir (branch retained). Not used by 2a; exported for later. */
export async function removeWorktree(wt: Worktree): Promise<void> {
  await wt.git.run(wt.path, ['worktree', 'remove', '--force', wt.path]);
}
