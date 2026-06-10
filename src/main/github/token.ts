/**
 * GitHub credential resolution: explicit `github.token` setting wins;
 * otherwise `gh auth token` (the dev's keychain-backed CLI auth). The gh
 * lookup is memoized for the process lifetime — flipping auth states
 * mid-session is not a supported flow. The token never leaves main.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: Exec = (cmd, args) =>
  promisify(execFile)(cmd, args, { timeout: 5_000 }) as Promise<{ stdout: string }>;

let ghToken: string | null | undefined; // undefined = not yet looked up

export function _resetTokenCache(): void {
  ghToken = undefined;
}

export async function resolveToken(
  settingsToken: string,
  exec: Exec = defaultExec,
): Promise<string | null> {
  if (settingsToken.trim() !== '') return settingsToken.trim();
  if (ghToken !== undefined) return ghToken;
  try {
    const { stdout } = await exec('gh', ['auth', 'token']);
    ghToken = stdout.trim() || null;
  } catch {
    ghToken = null;
  }
  return ghToken;
}
