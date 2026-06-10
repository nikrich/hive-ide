/**
 * PRs-view GitHub enrichment (PR 2 of 3 — spec
 * docs/specs/2026-06-10-prs-github-enrichment-design.md).
 *
 * Pure pieces (parsePrUrl / buildPrQuery / mapPrResponse) are exported for
 * unit tests; `enrichPrs` orchestrates them behind a 60s cache with injected
 * fetch/token/clock so tests never touch the network.
 */

import type { PrEnrichment } from '../../types/github';

export interface PrRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/;

export function parsePrUrl(url: string): Omit<PrRef, 'url'> | null {
  const m = PR_URL.exec(url);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** One aliased repository/pullRequest block per ref. Args are JSON-escaped. */
export function buildPrQuery(refs: readonly PrRef[]): string {
  const blocks = refs.map(
    (r, i) => `  p${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) {
    pullRequest(number: ${r.number}) {
      state isDraft additions deletions reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }`,
  );
  return `query {\n${blocks.join('\n')}\n}`;
}

function normalizeChecks(state: unknown): PrEnrichment['checks'] {
  if (state === 'SUCCESS') return 'passing';
  if (state === 'FAILURE' || state === 'ERROR') return 'failing';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  return null;
}

function normalizeReview(v: unknown): PrEnrichment['reviewDecision'] {
  if (v === 'APPROVED') return 'approved';
  if (v === 'CHANGES_REQUESTED') return 'changes-requested';
  if (v === 'REVIEW_REQUIRED') return 'review-required';
  return null;
}

export function mapPrResponse(
  refs: readonly PrRef[],
  json: unknown,
): Record<string, PrEnrichment | null> {
  const out: Record<string, PrEnrichment | null> = {};
  const data =
    typeof json === 'object' && json !== null
      ? (json as { data?: Record<string, unknown> }).data
      : undefined;
  refs.forEach((ref, i) => {
    const block = data?.[`p${i}`] as
      | { pullRequest?: Record<string, unknown> | null }
      | null
      | undefined;
    const pr = block?.pullRequest;
    if (!pr || typeof pr !== 'object') {
      out[ref.url] = null;
      return;
    }
    const state =
      pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : null;
    if (state === null) {
      out[ref.url] = null;
      return;
    }
    const commits = pr.commits as
      | { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: unknown } | null } }> }
      | undefined;
    const rollup = commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
    out[ref.url] = {
      state,
      isDraft: pr.isDraft === true,
      additions: typeof pr.additions === 'number' ? pr.additions : 0,
      deletions: typeof pr.deletions === 'number' ? pr.deletions : 0,
      reviewDecision: normalizeReview(pr.reviewDecision),
      checks: normalizeChecks(rollup?.state),
    };
  });
  return out;
}

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  at: number;
  value: PrEnrichment | null;
}
const cache = new Map<string, CacheEntry>();

export function _resetEnrichCache(): void {
  cache.clear();
}

export interface EnrichDeps {
  fetchFn: typeof fetch;
  getToken: () => Promise<string | null>;
  now: () => number;
}

/** Batched, cached, never-throws (for data reasons) enrichment. */
export async function enrichPrs(
  urls: readonly string[],
  deps: EnrichDeps,
): Promise<Record<string, PrEnrichment | null>> {
  const out: Record<string, PrEnrichment | null> = {};
  const misses: PrRef[] = [];
  const t = deps.now();

  for (const url of new Set(urls)) {
    const parsed = parsePrUrl(url);
    if (parsed === null) {
      out[url] = null;
      continue;
    }
    const hit = cache.get(url);
    if (hit !== undefined && t - hit.at < CACHE_TTL_MS) {
      out[url] = hit.value;
      continue;
    }
    misses.push({ url, ...parsed });
  }
  if (misses.length === 0) return out;

  const token = await deps.getToken();
  if (token === null) {
    for (const m of misses) out[m.url] = null;
    return out;
  }

  let mapped: Record<string, PrEnrichment | null>;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await deps.fetchFn('https://api.github.com/graphql', {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: buildPrQuery(misses) }),
      });
      if (!res.ok) throw new Error(`github: HTTP ${res.status}`);
      mapped = mapPrResponse(misses, await res.json());
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('github enrichment failed:', err instanceof Error ? err.message : err);
    mapped = Object.fromEntries(misses.map((m) => [m.url, null]));
  }
  for (const m of misses) {
    out[m.url] = mapped[m.url] ?? null;
    cache.set(m.url, { at: t, value: out[m.url] });
  }
  return out;
}
