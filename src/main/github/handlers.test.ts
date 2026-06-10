import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...a: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (...a: unknown[]) => unknown) => handlers.set(c, fn),
    removeHandler: (c: string) => handlers.delete(c),
  },
}));

import { _resetEnrichCache } from './enrich';
import { GITHUB_CHANNELS, registerGithubHandlers } from './handlers';
import { _resetTokenCache } from './token';

const SENTINEL = 'ghp_SENTINEL_TOKEN_do_not_leak';

const invoke = (c: string, ...a: unknown[]): unknown => handlers.get(c)?.({}, ...a);

const payload = {
  data: {
    p0: {
      pullRequest: {
        state: 'OPEN',
        isDraft: false,
        additions: 1,
        deletions: 1,
        reviewDecision: null,
        commits: { nodes: [] },
      },
    },
  },
};

let teardown: () => void;

beforeEach(() => {
  teardown = registerGithubHandlers({ getSettingsToken: () => SENTINEL });
});

afterEach(() => {
  teardown();
  handlers.clear();
  _resetEnrichCache();
  _resetTokenCache();
  vi.unstubAllGlobals();
});

describe('github enrich-prs handler', () => {
  it('rejects non-array and non-string-array urls with TypeError', async () => {
    await expect(invoke(GITHUB_CHANNELS.enrichPrs, 'not-an-array')).rejects.toThrow(TypeError);
    await expect(invoke(GITHUB_CHANNELS.enrichPrs, [42])).rejects.toThrow(/string\[\]/);
  });

  it('never leaks the resolved token into the response (token-leak gate)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetchFn);
    const url = 'https://github.com/a/b/pull/1';
    const out = await invoke(GITHUB_CHANNELS.enrichPrs, [url]);
    expect(fetchFn).toHaveBeenCalledTimes(1); // sanity: the sentinel WAS used
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe(`bearer ${SENTINEL}`);
    const serialized = JSON.stringify(out);
    expect(serialized).toContain('"state":"open"');
    expect(serialized).not.toContain(SENTINEL);
  });

  it('teardown removes the handler', () => {
    expect(handlers.has(GITHUB_CHANNELS.enrichPrs)).toBe(true);
    teardown();
    expect(handlers.has(GITHUB_CHANNELS.enrichPrs)).toBe(false);
  });
});
