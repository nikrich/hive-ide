import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildPrQuery, enrichPrs, mapPrResponse, parsePrUrl, _resetEnrichCache } from './enrich';

afterEach(() => _resetEnrichCache());

describe('parsePrUrl', () => {
  it('parses a canonical PR url (and tolerates a trailing slash)', () => {
    expect(parsePrUrl('https://github.com/nikrich/hive-ide/pull/54')).toEqual({
      owner: 'nikrich', repo: 'hive-ide', number: 54,
    });
    expect(parsePrUrl('https://github.com/o/r/pull/7/')).toEqual({ owner: 'o', repo: 'r', number: 7 });
  });
  it('rejects non-github, enterprise hosts, and malformed paths', () => {
    expect(parsePrUrl('https://gitlab.com/o/r/-/merge_requests/1')).toBeNull();
    expect(parsePrUrl('https://github.enterprise.co/o/r/pull/1')).toBeNull();
    expect(parsePrUrl('https://github.com/o/r/issues/1')).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
  });
  it('rejects numbers outside the positive GraphQL Int range', () => {
    // 1e+21 would fail GraphQL parsing and null the whole batch.
    expect(parsePrUrl('https://github.com/o/r/pull/999999999999999999999')).toBeNull();
    expect(parsePrUrl('https://github.com/o/r/pull/0')).toBeNull();
    expect(parsePrUrl('https://github.com/o/r/pull/2147483648')).toBeNull();
  });
});

describe('buildPrQuery', () => {
  it('aliases one block per PR with escaped args', () => {
    const q = buildPrQuery([
      { url: 'u0', owner: 'a', repo: 'b', number: 1 },
      { url: 'u1', owner: 'c', repo: 'd-e', number: 22 },
    ]);
    expect(q).toContain('p0: repository(owner: "a", name: "b")');
    expect(q).toContain('pullRequest(number: 1)');
    expect(q).toContain('p1: repository(owner: "c", name: "d-e")');
    expect(q).toContain('statusCheckRollup');
  });
});

describe('mapPrResponse', () => {
  const refs = [
    { url: 'https://github.com/a/b/pull/1', owner: 'a', repo: 'b', number: 1 },
    { url: 'https://github.com/c/d/pull/2', owner: 'c', repo: 'd', number: 2 },
  ];
  it('maps fields and normalizes enums', () => {
    const out = mapPrResponse(refs, {
      data: {
        p0: {
          pullRequest: {
            state: 'MERGED', isDraft: false, additions: 10, deletions: 3,
            reviewDecision: 'APPROVED',
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
          },
        },
        p1: {
          pullRequest: {
            state: 'OPEN', isDraft: true, additions: 1, deletions: 0,
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          },
        },
      },
    });
    expect(out[refs[0].url]).toEqual({
      state: 'merged', isDraft: false, additions: 10, deletions: 3,
      reviewDecision: 'approved', checks: 'passing',
    });
    expect(out[refs[1].url]).toEqual({
      state: 'open', isDraft: true, additions: 1, deletions: 0,
      reviewDecision: null, checks: null,
    });
  });
  it('nulls only the failed alias on partial errors', () => {
    const out = mapPrResponse(refs, {
      data: { p0: null, p1: { pullRequest: { state: 'CLOSED', isDraft: false, additions: 0, deletions: 0, reviewDecision: 'CHANGES_REQUESTED', commits: { nodes: [] } } } },
      errors: [{ message: 'Could not resolve' }],
    });
    expect(out[refs[0].url]).toBeNull();
    expect(out[refs[1].url]).toEqual({
      state: 'closed', isDraft: false, additions: 0, deletions: 0,
      reviewDecision: 'changes-requested', checks: null,
    });
  });
  it('nulls everything on garbage', () => {
    const out = mapPrResponse(refs, 'not json at all');
    expect(out[refs[0].url]).toBeNull();
    expect(out[refs[1].url]).toBeNull();
  });
});

describe('enrichPrs', () => {
  const url = 'https://github.com/a/b/pull/1';
  const payload = (state = 'OPEN') => ({
    data: { p0: { pullRequest: { state, isDraft: false, additions: 1, deletions: 1, reviewDecision: null, commits: { nodes: [] } } } },
  });

  it('fetches once and serves the second call from cache inside the TTL', async () => {
    let t = 0;
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => payload() });
    const deps = { fetchFn, getToken: async () => 'tok', now: () => t };
    expect((await enrichPrs([url], deps))[url]?.state).toBe('open');
    t = 59_000;
    await enrichPrs([url], deps);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = 61_000;
    await enrichPrs([url], deps);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns all-null without a token and never fetches', async () => {
    const fetchFn = vi.fn();
    const out = await enrichPrs([url, 'https://gitlab.com/x'], { fetchFn, getToken: async () => null, now: () => 0 });
    expect(out).toEqual({ [url]: null, 'https://gitlab.com/x': null });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('collapses transport failures to null without throwing', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await enrichPrs([url], { fetchFn, getToken: async () => 'tok', now: () => 0 });
    expect(out[url]).toBeNull();
  });

  it('sends one batched POST with a bearer header', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => payload() });
    await enrichPrs([url, 'https://github.com/c/d/pull/2'], { fetchFn, getToken: async () => 'tok', now: () => 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [target, init] = fetchFn.mock.calls[0];
    expect(target).toBe('https://api.github.com/graphql');
    expect(init.headers.Authorization).toBe('bearer tok');
    expect(init.redirect).toBe('error');
  });
});
