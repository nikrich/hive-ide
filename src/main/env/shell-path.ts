/**
 * Login-shell PATH recovery.
 *
 * When a packaged app is launched from the macOS Finder/Dock (or a Linux
 * desktop launcher), the process inherits the minimal PATH that the OS login
 * agent hands GUI apps (roughly `/usr/bin:/bin:/usr/sbin:/sbin`) — it does NOT
 * source the user's shell rc/profile. So tools the user installed into
 * `~/.local/bin`, `/opt/homebrew/bin`, an npm global dir, etc. are invisible,
 * and any `spawn('claude', …)` fails with ENOENT. Launching the same app from
 * a terminal works because the terminal already exported the full PATH.
 *
 * `fixPath()` asks the user's login shell what its PATH is and merges that into
 * `process.env.PATH`, so subsequent child processes (claude, git, debug
 * adapters) resolve the same binaries the user sees in their terminal. No-op on
 * Windows, where GUI processes already inherit the system/user PATH.
 *
 * The shell-exec function is injected so this is unit-testable without a real
 * shell, mirroring the `spawnFn`/`createRunner` injection used elsewhere.
 */

import { execFileSync } from 'node:child_process';

/** Wraps the captured PATH so we can pull it out of noisy shell startup output. */
export const SHELL_PATH_DELIM = '__HIVE_SHELL_PATH__';

export type ExecFn = (shell: string, args: readonly string[]) => string;

export interface ShellPathDeps {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Login shell to probe. Defaults to `$SHELL`, then `/bin/zsh`. */
  shell?: string;
  /** Shell-exec function (injected for tests). */
  exec?: ExecFn;
  /** Environment to read/mutate. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const defaultExec: ExecFn = (shell, args) =>
  execFileSync(shell, args as string[], { encoding: 'utf8', timeout: 5000 });

/**
 * Query the user's login shell for its resolved PATH. Returns null on Windows,
 * when the probe fails, or when the shell reports an empty PATH.
 */
export function queryShellPath(deps: ShellPathDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return null;

  const env = deps.env ?? process.env;
  const shell = deps.shell ?? env.SHELL ?? '/bin/zsh';
  const exec = deps.exec ?? defaultExec;

  try {
    // `-ilc`: interactive login shell running a command, so both login
    // (`.zprofile`/`.profile`) and rc (`.zshrc`/`.bashrc`) files are sourced.
    // Delimiters let us recover PATH even when startup files print banners.
    //
    // `${PATH}` MUST be braced: the delimiter starts with `_`, so an unbraced
    // `$PATH${SHELL_PATH_DELIM}` is parsed by the shell as a single variable
    // name `PATH<DELIM>` (all valid identifier chars) → unset → empty, leaving
    // only one delimiter in the output and silently breaking PATH recovery.
    const out = exec(shell, ['-ilc', `printf '%s' "${SHELL_PATH_DELIM}\${PATH}${SHELL_PATH_DELIM}"`]);
    const start = out.indexOf(SHELL_PATH_DELIM);
    const end = out.indexOf(SHELL_PATH_DELIM, start + SHELL_PATH_DELIM.length);
    if (start === -1 || end === -1) return null;
    const path = out.slice(start + SHELL_PATH_DELIM.length, end).trim();
    return path === '' ? null : path;
  } catch {
    return null;
  }
}

/**
 * Merge the login-shell PATH into `env.PATH` (default `process.env`), keeping
 * shell entries first and de-duplicating. Returns the new PATH, or null when no
 * change was made (Windows, probe failure). Safe to call once at startup.
 */
export function fixPath(deps: ShellPathDeps = {}): string | null {
  const shellPath = queryShellPath(deps);
  if (shellPath === null) return null;

  const env = deps.env ?? process.env;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...shellPath.split(':'), ...(env.PATH ?? '').split(':')]) {
    if (entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }

  const next = merged.join(':');
  env.PATH = next;
  return next;
}
