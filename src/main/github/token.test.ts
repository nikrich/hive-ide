import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetTokenCache, resolveToken } from './token';

afterEach(() => _resetTokenCache());

describe('resolveToken', () => {
  it('prefers a non-empty settings token', async () => {
    const exec = vi.fn();
    expect(await resolveToken('ghp_settings', exec)).toBe('ghp_settings');
    expect(exec).not.toHaveBeenCalled();
  });
  it('falls back to gh auth token and trims it', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'gho_cli\n' });
    expect(await resolveToken('', exec)).toBe('gho_cli');
    expect(exec).toHaveBeenCalledWith('gh', ['auth', 'token']);
  });
  it('returns null when gh is missing/unauthed, and memoizes the result', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('ENOENT'));
    expect(await resolveToken('', exec)).toBeNull();
    expect(await resolveToken('', exec)).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
