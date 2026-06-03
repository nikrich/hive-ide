/**
 * Git subprocess runner — REQ-008.
 *
 * Single tiny wrapper around `child_process.execFile('git', ...)`. The whole
 * SCM slice routes through this so we have one place to:
 *
 *   - Validate that the requested cwd exists and is a real git repo
 *     (`.git` may be a directory OR a file — `git worktree` uses a
 *     pointer file, so we accept both).
 *   - Cap the output (a runaway `git diff` on a giant repo would hang the
 *     renderer; 10 MB is a wide guard rail — diff files larger than that
 *     don't render usefully anyway).
 *   - Force `GIT_TERMINAL_PROMPT=0` so a missing credential helper never
 *     pops a tty prompt into the void.
 *   - Surface stdout + stderr + exit code back to the caller so the IPC
 *     handler can decide what to do with non-zero (e.g. `git push` returns
 *     1 with an explanatory stderr on auth failures — the renderer
 *     surfaces that in a toast).
 *
 * No shell interpretation — we use `execFile`, not `exec`. The argv array
 * is passed verbatim to the OS so a path containing spaces / shell
 * metacharacters can't be reinterpreted.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** Result of a single git invocation. */
export interface GitRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or null when killed by a signal. */
  code: number | null;
}

/** Options for `GitRunner.run`. */
export interface GitRunOptions {
  /** Optional stdin payload — used by e.g. `git commit -F -`. */
  stdin?: string;
  /** Output cap in MiB. Default 10. */
  maxBufferMB?: number;
}

const DEFAULT_MAX_BUFFER_MB = 10;

/**
 * Wraps `execFile('git', ...)` with cwd validation, output capping, and
 * a non-interactive env. Stateless; instances are cheap.
 */
export class GitRunner {
  async run(
    cwd: string,
    args: string[],
    opts: GitRunOptions = {},
  ): Promise<GitRunResult> {
    await assertGitRepo(cwd);
    const maxBuffer =
      (opts.maxBufferMB ?? DEFAULT_MAX_BUFFER_MB) * 1024 * 1024;

    return new Promise<GitRunResult>((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        {
          cwd,
          maxBuffer,
          encoding: 'utf8',
          env: {
            ...process.env,
            // Never pop a terminal credential prompt (auth-required pushes
            // need to fail fast with a stderr message instead of hanging).
            GIT_TERMINAL_PROMPT: '0',
            // Stable, locale-independent output for parsers.
            LC_ALL: 'C',
            LANG: 'C',
          },
          windowsHide: true,
        },
        (err, stdoutBuf, stderrBuf) => {
          const stdout = typeof stdoutBuf === 'string' ? stdoutBuf : '';
          const stderr = typeof stderrBuf === 'string' ? stderrBuf : '';

          if (err) {
            // execFile reports a non-zero exit as an error. We treat that
            // as a successful run that happened to fail — the caller (the
            // IPC handler) decides whether to surface stderr to the user.
            const code = (err as NodeJS.ErrnoException & { code?: number | string })
              .code;
            if (typeof code === 'number') {
              resolve({ stdout, stderr, code });
              return;
            }
            // ENOENT / EACCES / "maxBuffer exceeded" → real failure.
            reject(err);
            return;
          }
          resolve({ stdout, stderr, code: 0 });
        },
      );

      if (opts.stdin !== undefined && child.stdin) {
        child.stdin.end(opts.stdin);
      }
    });
  }
}

/**
 * Throw a friendly error if `cwd` doesn't exist or isn't a git repo.
 * Accepts both worktree pointer files (`.git` is a file) and ordinary
 * `.git/` directories.
 */
async function assertGitRepo(cwd: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(cwd);
  } catch {
    throw new Error(`git: cwd does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`git: cwd is not a directory: ${cwd}`);
  }
  const dotGit = join(cwd, '.git');
  try {
    await fs.stat(dotGit);
  } catch {
    throw new Error(`git: not a git repository: ${cwd}`);
  }
}
