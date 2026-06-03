/**
 * Git IPC handlers — REQ-008.
 *
 * Twelve channels under `ipc:hive:git:*`. Each request takes a `repoPath`
 * (an absolute filesystem path) plus any per-operation payload. The cwd
 * is validated by {@link GitRunner.run} on every call — so a malicious
 * renderer can't issue `git push` against `/etc`.
 *
 * Channel map:
 *
 *   status        → GitStatusEntry[]
 *   diff          → unified diff text (vs HEAD or vs index)
 *   file-show     → raw contents of `:path` at a specific ref
 *   stage         → `git add -- <paths>`
 *   unstage       → `git restore --staged -- <paths>`
 *   discard       → `git restore -- <tracked>` + fs.unlink for untracked
 *   commit        → `git commit -m <msg>` (with `--allow-empty-message`
 *                   guarded out — the renderer disables the button when
 *                   the message is blank)
 *   push          → `git push`
 *   pull          → `git pull --ff-only`
 *   branches      → { current, local[], remote[] }
 *   checkout      → `git checkout <branch>` or `-b` for create
 *   ahead-behind  → ahead/behind vs upstream
 *
 * The slice keeps a single shared `GitRunner` instance — stateless and
 * cheap.
 */

import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

import type { GitStatusSummary } from '../../types/workspace';
import {
  parseAheadBehind,
  parseBranchOutput,
  parseStatusPorcelainV2,
  parseStatusSummary,
} from './parsers';
import { GitRunner } from './runner';

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const GIT_CHANNELS = {
  status: 'ipc:hive:git:status',
  diff: 'ipc:hive:git:diff',
  fileShow: 'ipc:hive:git:file-show',
  stage: 'ipc:hive:git:stage',
  unstage: 'ipc:hive:git:unstage',
  discard: 'ipc:hive:git:discard',
  commit: 'ipc:hive:git:commit',
  push: 'ipc:hive:git:push',
  pull: 'ipc:hive:git:pull',
  branches: 'ipc:hive:git:branches',
  checkout: 'ipc:hive:git:checkout',
  aheadBehind: 'ipc:hive:git:ahead-behind',
} as const;

const ALL_CHANNELS: ReadonlyArray<string> = Object.values(GIT_CHANNELS);

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`git: ${label} must be a non-empty string`);
  }
  return value;
}

function requirePathArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`git: ${label} must be a non-empty array of strings`);
  }
  return value.map((v, i) => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new TypeError(`git: ${label}[${i}] must be a non-empty string`);
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGitHandlers(): () => void {
  const runner = new GitRunner();

  ipcMain.handle(
    GIT_CHANNELS.status,
    async (_event, payload: { repoPath: string }): Promise<GitStatusSummary> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const result = await runner.run(repoPath, [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
      ]);
      // One invocation yields entries + branch + ahead/behind, so `fetchScm`
      // no longer needs separate `branches` / `aheadBehind` calls.
      return parseStatusSummary(result.stdout);
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.diff,
    async (
      _event,
      payload: { repoPath: string; path: string; ref: 'index' | 'head' },
    ): Promise<string> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const path = requireString(payload?.path, 'path');
      const ref = payload?.ref;
      if (ref !== 'index' && ref !== 'head') {
        throw new TypeError("git: ref must be 'index' or 'head'");
      }
      // ref='head' → diff working tree vs HEAD (the "what changed" view
      //              the user thinks of when looking at the Changes pane).
      // ref='index'→ diff index vs HEAD (what `git commit` would record).
      const args =
        ref === 'head'
          ? ['diff', '--no-color', 'HEAD', '--', path]
          : ['diff', '--no-color', '--cached', '--', path];
      const result = await runner.run(repoPath, args);
      return result.stdout;
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.fileShow,
    async (
      _event,
      payload: { repoPath: string; path: string; ref: string },
    ): Promise<string> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const path = requireString(payload?.path, 'path');
      const ref = requireString(payload?.ref, 'ref');
      // Map our two named refs onto git's syntax. Anything else is treated
      // as a literal revision (the spec opens that door for future history).
      const rev =
        ref === 'head' ? 'HEAD' : ref === 'index' ? '' : ref;
      const spec = `${rev}:${path}`;
      const result = await runner.run(repoPath, ['show', spec]);
      if (result.code !== 0) {
        // A missing object (e.g. file didn't exist at that ref) → return
        // empty rather than throw. The diff view treats that as the
        // "added file" case (LHS empty).
        return '';
      }
      return result.stdout;
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.stage,
    async (_event, payload: { repoPath: string; paths: string[] }): Promise<void> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const paths = requirePathArray(payload?.paths, 'paths');
      await runner.run(repoPath, ['add', '--', ...paths]);
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.unstage,
    async (_event, payload: { repoPath: string; paths: string[] }): Promise<void> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const paths = requirePathArray(payload?.paths, 'paths');
      // `restore --staged` is the modern equivalent of `reset HEAD --`,
      // and unlike `reset` it never touches the working tree.
      await runner.run(repoPath, ['restore', '--staged', '--', ...paths]);
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.discard,
    async (
      _event,
      payload: { repoPath: string; paths: string[] },
    ): Promise<void> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const paths = requirePathArray(payload?.paths, 'paths');
      // Split into tracked / untracked: tracked → `git restore`, untracked
      // → `fs.unlink`. We trust the renderer's confirmation modal — the
      // handler itself is destructive.
      const statusResult = await runner.run(repoPath, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
      ]);
      const entries = parseStatusPorcelainV2(statusResult.stdout);
      const untrackedSet = new Set(
        entries
          .filter((e) => e.state === 'untracked')
          .map((e) => e.path),
      );
      const tracked: string[] = [];
      const untracked: string[] = [];
      for (const p of paths) {
        if (untrackedSet.has(p)) untracked.push(p);
        else tracked.push(p);
      }
      if (tracked.length > 0) {
        await runner.run(repoPath, ['restore', '--worktree', '--', ...tracked]);
      }
      for (const rel of untracked) {
        // Resolve the repo-relative path against `repoPath` and verify
        // the result stays inside the repo before unlinking — defence in
        // depth in case the renderer ever ships a path with `..`.
        const abs = resolve(repoPath, rel);
        const prefix = repoPath.endsWith('/') ? repoPath : repoPath + '/';
        if (!abs.startsWith(prefix) && abs !== repoPath) {
          throw new Error(`git: discard refused — path escapes repo: ${rel}`);
        }
        try {
          await fs.unlink(abs);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') throw err;
          // Already gone — fine.
        }
      }
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.commit,
    async (
      _event,
      payload: { repoPath: string; message: string },
    ): Promise<void> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const message = requireString(payload?.message, 'message');
      // `-F -` reads the message from stdin so we don't have to worry
      // about argv length limits or quoting; the runner pipes it in.
      const result = await runner.run(repoPath, ['commit', '-F', '-'], {
        stdin: message,
      });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || 'git commit failed');
      }
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.push,
    async (
      _event,
      payload: { repoPath: string },
    ): Promise<{ ahead: number; behind: number; stdout: string }> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const pushResult = await runner.run(repoPath, ['push']);
      if (pushResult.code !== 0) {
        throw new Error(pushResult.stderr.trim() || 'git push failed');
      }
      const ab = await readAheadBehind(runner, repoPath);
      return { ...ab, stdout: pushResult.stdout + pushResult.stderr };
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.pull,
    async (
      _event,
      payload: { repoPath: string },
    ): Promise<{ ahead: number; behind: number; stdout: string }> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      // `--ff-only` so we never silently create a merge commit; an
      // operator who wants a merge can do that explicitly via terminal.
      const pullResult = await runner.run(repoPath, ['pull', '--ff-only']);
      if (pullResult.code !== 0) {
        throw new Error(pullResult.stderr.trim() || 'git pull failed');
      }
      const ab = await readAheadBehind(runner, repoPath);
      return { ...ab, stdout: pullResult.stdout + pullResult.stderr };
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.branches,
    async (
      _event,
      payload: { repoPath: string },
    ): Promise<{ current: string; local: string[]; remote: string[] }> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const result = await runner.run(repoPath, [
        'branch',
        '--list',
        '--all',
        '--format=%(refname:short)\t%(HEAD)',
      ]);
      return parseBranchOutput(result.stdout);
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.checkout,
    async (
      _event,
      payload: { repoPath: string; branch: string; create?: boolean },
    ): Promise<void> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      const branch = requireString(payload?.branch, 'branch');
      const create = payload?.create === true;
      const args = create
        ? ['checkout', '-b', branch]
        : ['checkout', branch];
      const result = await runner.run(repoPath, args);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || 'git checkout failed');
      }
    },
  );

  ipcMain.handle(
    GIT_CHANNELS.aheadBehind,
    async (
      _event,
      payload: { repoPath: string },
    ): Promise<{ ahead: number; behind: number }> => {
      const repoPath = requireString(payload?.repoPath, 'repoPath');
      return readAheadBehind(runner, repoPath);
    },
  );

  return () => {
    for (const ch of ALL_CHANNELS) ipcMain.removeHandler(ch);
  };
}

/**
 * Read ahead/behind by running `git status --porcelain=v2 --branch` and
 * pulling the `# branch.ab` header. We don't want to surface the whole
 * status object here — `fetchScm` calls it separately.
 */
async function readAheadBehind(
  runner: GitRunner,
  repoPath: string,
): Promise<{ ahead: number; behind: number }> {
  const result = await runner.run(repoPath, [
    'status',
    '--porcelain=v2',
    '--branch',
  ]);
  return parseAheadBehind(result.stdout);
}

// Keep TS happy if `join` becomes unused after future edits.
void join;
