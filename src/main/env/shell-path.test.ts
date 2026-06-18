import { describe, it, expect, vi } from 'vitest';

import { queryShellPath, fixPath, SHELL_PATH_DELIM } from './shell-path';

/** Build the delimited output a login shell prints for our probe. */
function shellOutput(path: string): string {
  return `some login banner noise\n${SHELL_PATH_DELIM}${path}${SHELL_PATH_DELIM}\n`;
}

describe('queryShellPath', () => {
  it('returns the PATH the login shell prints, stripped of surrounding noise', () => {
    const exec = vi.fn(() => shellOutput('/opt/homebrew/bin:/usr/bin:/bin'));
    const path = queryShellPath({ platform: 'darwin', shell: '/bin/zsh', exec });
    expect(path).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('invokes the login shell with an interactive-login flag so rc files are sourced', () => {
    const exec = vi.fn(() => shellOutput('/usr/bin'));
    queryShellPath({ platform: 'darwin', shell: '/bin/zsh', exec });
    const [shell, args] = exec.mock.calls[0];
    expect(shell).toBe('/bin/zsh');
    expect(args).toContain('-ilc');
  });

  it('is a no-op on win32 (PATH already inherited correctly there)', () => {
    const exec = vi.fn(() => shellOutput('/usr/bin'));
    expect(queryShellPath({ platform: 'win32', exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns null when the shell probe throws (e.g. missing shell)', () => {
    const exec = vi.fn(() => { throw new Error('ENOENT'); });
    expect(queryShellPath({ platform: 'darwin', shell: '/bin/zsh', exec })).toBeNull();
  });

  it('returns null when the delimited PATH is empty', () => {
    const exec = vi.fn(() => shellOutput(''));
    expect(queryShellPath({ platform: 'darwin', shell: '/bin/zsh', exec })).toBeNull();
  });
});

describe('fixPath', () => {
  it('merges the shell PATH ahead of the existing env PATH, de-duplicating', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const exec = vi.fn(() => shellOutput('/opt/homebrew/bin:/usr/bin'));
    const result = fixPath({ platform: 'darwin', shell: '/bin/zsh', exec, env });
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(result).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('leaves env.PATH untouched on win32', () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows' };
    const exec = vi.fn();
    expect(fixPath({ platform: 'win32', exec, env })).toBeNull();
    expect(env.PATH).toBe('C:\\Windows');
  });

  it('leaves env.PATH untouched when the probe fails', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const exec = vi.fn(() => { throw new Error('boom'); });
    expect(fixPath({ platform: 'darwin', shell: '/bin/zsh', exec, env })).toBeNull();
    expect(env.PATH).toBe('/usr/bin');
  });
});
