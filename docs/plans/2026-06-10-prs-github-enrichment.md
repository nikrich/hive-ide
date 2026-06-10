# PRs GitHub Enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich PRs-view cards with live GitHub data (state+draft, checks rollup, +/− stats, review decision) via one batched main-process GraphQL request, degrading silently to today's prUrl-only cards without a credential.

**Architecture:** New `src/main/github/` module (pure parse/query/map + cached orchestration with injected deps), `gh auth token`-with-settings-override credential resolution, one IPC handler + preload passthrough, and PRsView-owned enrichment state. `PrCard`/`toPrCards` untouched.

**Tech Stack:** TypeScript, Electron main `fetch` (plugins-module hygiene), `node:child_process` execFile, Vitest (+ happy-dom/RTL for PRsView). Spec: `docs/specs/2026-06-10-prs-github-enrichment-design.md`.

**Worktree:** `/Users/jannik/development/nikrich/hive-ide/.claude/worktrees/feat-pr-enrich` (branch `worktree-feat-pr-enrich`, based on main @ `3ad466f` — includes the e2e suite). Baseline: unit suite green, `npx playwright test` 11/11 (run `npm run build` first if out/ is missing).

**Key facts:**
- Fetch hygiene template: `safeFetchText` in `src/main/plugins/handlers.ts:95-120` (AbortController timeout, `redirect: 'error'`, streamed byte ceiling). Mirror the pattern; don't import it (it's registry-specific).
- Settings: typed total record — add keys to `Settings` AND `DEFAULT_SETTINGS` in `src/types/settings.ts` (file header documents the 4-step recipe). Main-side store: `src/main/settings/store.ts` (`SettingsStore` instance is constructed in `src/main/index.ts` whenReady, ~line 221; it exposes the merged settings — find its getter, likely `.current()` or `.get()` — read the class before wiring).
- Handler registration pattern: sibling modules export `register*Handlers(deps): () => void` (e.g. `src/main/hive/handlers.ts`); `src/main/index.ts` calls them in whenReady and keeps the teardown.
- Preload: channel map + invoke passthrough in `src/preload/index.ts`; bridge interface in `src/preload/api.ts` (follow `HiveOrchestrationBridge`'s style); root `HiveBridge` interface lists top-level bridges (~line 790).
- PRsView: `src/renderer/src/components/PRsView.tsx` — props `{ prs: PrCard[], projectLabel }`; `PrCard` has `{ storyId, num, title, role, branch, status: 'review'|'merged', url, time }`; cards render `.view .card` with `PR_ICON`, `RoleAva`, branch chip, `StatusChip status={pr.status}`, time, Open `Btn`. Component test conventions: `// @vitest-environment happy-dom`, RTL, see `SearchView.test.tsx`.
- E2E PRs test (`e2e/specs/orchestration.spec.ts` "PRs view renders live cards…") asserts `#77`, title, branch, Open button, and empty state — it must keep passing unchanged (CI has no GitHub credential = the degradation path).
- GitHub GraphQL: POST `https://api.github.com/graphql`, header `Authorization: bearer <token>`. PR fields: `state` (OPEN|CLOSED|MERGED), `isDraft`, `additions`, `deletions`, `reviewDecision` (APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|null), checks via `commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }` (SUCCESS|FAILURE|ERROR|PENDING|EXPECTED, or the rollup object is null when no checks). Partial failures: `data.<alias>` is null and `errors[]` describes it — other aliases still resolve.

---

## File Structure

- Create: `src/types/github.ts` (`PrEnrichment`)
- Create: `src/main/github/enrich.ts` + `enrich.test.ts`
- Create: `src/main/github/token.ts` + `token.test.ts`
- Create: `src/main/github/handlers.ts`
- Modify: `src/types/settings.ts` (key + default), `src/main/index.ts` (register), `src/preload/api.ts`, `src/preload/index.ts`
- Modify: `src/renderer/src/components/PRsView.tsx`; Create: `PRsView.test.tsx`

---

## Task 1: Types + pure functions (parse / query / map)

**Files:**
- Create: `src/types/github.ts`, `src/main/github/enrich.ts`
- Test: `src/main/github/enrich.test.ts`

- [ ] **Step 1: the shared type**

`src/types/github.ts`:

```typescript
/** Live GitHub data for one PR card (PRs view enrichment). */
export interface PrEnrichment {
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  additions: number;
  deletions: number;
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null;
  /** Rollup of the head commit's checks; null when the PR has no checks. */
  checks: 'passing' | 'failing' | 'pending' | null;
}
```

- [ ] **Step 2: failing tests**

`src/main/github/enrich.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildPrQuery, mapPrResponse, parsePrUrl } from './enrich';

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
```

Run: `npx vitest run src/main/github/enrich.test.ts` → FAIL (module not found).

- [ ] **Step 3: implement the pure parts** in `src/main/github/enrich.ts`:

```typescript
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
```

Run the tests → PASS (6).

- [ ] **Step 4: commit**

```bash
git add src/types/github.ts src/main/github/enrich.ts src/main/github/enrich.test.ts
git commit -m "feat(github): PR url parsing + batched GraphQL query/map for enrichment"
```

---

## Task 2: Token resolution + settings key

**Files:**
- Create: `src/main/github/token.ts`; Test: `src/main/github/token.test.ts`
- Modify: `src/types/settings.ts`

- [ ] **Step 1: settings key.** In `src/types/settings.ts`, follow the file's own 4-step recipe (header comment) to add:

```typescript
  // ----- github -------------------------------------------------------
  /** PAT for PRs-view enrichment; overrides the `gh` CLI token when set. */
  'github.token': string
```

and `'github.token': ''` to `DEFAULT_SETTINGS`. (If the recipe mentions a settings-editor schema/labels file, follow that step too — grep `'search.exclude'` to find every registry the recipe means.)

- [ ] **Step 2: failing tests** — `src/main/github/token.test.ts`:

```typescript
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
```

Run → FAIL.

- [ ] **Step 3: implement** `src/main/github/token.ts`:

```typescript
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
```

Run → PASS (3). Typecheck.

- [ ] **Step 4: commit**

```bash
git add src/main/github/token.ts src/main/github/token.test.ts src/types/settings.ts <any settings-registry file the recipe required>
git commit -m "feat(github): token resolution (settings override, gh CLI fallback) + github.token setting"
```

---

## Task 3: enrichPrs orchestration + IPC + preload

**Files:**
- Modify: `src/main/github/enrich.ts` (append) + `enrich.test.ts` (append)
- Create: `src/main/github/handlers.ts`
- Modify: `src/main/index.ts`, `src/preload/api.ts`, `src/preload/index.ts`

- [ ] **Step 1: failing tests** (append to `enrich.test.ts`):

```typescript
import { enrichPrs, _resetEnrichCache } from './enrich';
import { afterEach, vi } from 'vitest'; // merge into existing imports

afterEach(() => _resetEnrichCache());

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
```

Run → FAIL.

- [ ] **Step 2: implement** (append to `enrich.ts`):

```typescript
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
```

Run → PASS (10 total in the file). NOTE the cache stores nulls too (a failed lookup isn't retried for 60s — acceptable, and what the Refresh-button title documents).

- [ ] **Step 3: handler + wiring.** Create `src/main/github/handlers.ts`:

```typescript
/** `ipc:hive:github:enrich-prs` — renderer-facing enrichment endpoint. */
import { ipcMain } from 'electron';

import { enrichPrs } from './enrich';
import { resolveToken } from './token';

export const GITHUB_CHANNELS = { enrichPrs: 'ipc:hive:github:enrich-prs' } as const;

export interface GithubHandlerDeps {
  /** Read the CURRENT merged settings value for github.token. */
  getSettingsToken: () => string;
}

export function registerGithubHandlers(deps: GithubHandlerDeps): () => void {
  ipcMain.handle(GITHUB_CHANNELS.enrichPrs, async (_e, urls: unknown) => {
    if (!Array.isArray(urls) || !urls.every((u): u is string => typeof u === 'string')) {
      throw new TypeError('github: urls must be string[]');
    }
    return enrichPrs(urls, {
      fetchFn: fetch,
      getToken: () => resolveToken(deps.getSettingsToken()),
      now: () => Date.now(),
    });
  });
  return () => ipcMain.removeHandler(GITHUB_CHANNELS.enrichPrs);
}
```

In `src/main/index.ts` (whenReady, near the other register calls): `registerGithubHandlers({ getSettingsToken: () => settingsStore.<merged-getter>()['github.token'] })` — read `SettingsStore` (`src/main/settings/store.ts`) for the real merged-settings getter name and keep the read LAZY (per call, not captured once). Add the teardown to wherever siblings store theirs.

Preload — `src/preload/api.ts`:

```typescript
export interface HiveGithubBridge {
  /** Batched PR enrichment; null values = no data (no credential / failure). */
  enrichPrs(urls: string[]): Promise<Record<string, import('../types/github').PrEnrichment | null>>;
}
```

plus `github: HiveGithubBridge;` on the root bridge interface. `src/preload/index.ts`: add the channel constant and `github: { enrichPrs: (urls) => ipcRenderer.invoke(GITHUB.enrichPrs, urls) }` following the file's conventions.

- [ ] **Step 4: verify + commit**

`npm run typecheck && npx vitest run src/main/github/` → PASS.

```bash
git add src/main/github/ src/main/index.ts src/preload/api.ts src/preload/index.ts
git commit -m "feat(github): batched cached enrichPrs + IPC handler + preload bridge"
```

---

## Task 4: PRsView integration

**Files:**
- Modify: `src/renderer/src/components/PRsView.tsx`
- Test: `src/renderer/src/components/PRsView.test.tsx` (new)

- [ ] **Step 1: failing component test** — `PRsView.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { PRsView } from './PRsView'
import type { PrCard } from '../lib/hiveView'

const CARD: PrCard = {
  storyId: 'S1', num: 54, title: 'Ship it', role: 'senior', branch: 'feat/x',
  status: 'review', url: 'https://github.com/o/r/pull/54', time: '1h ago',
}

const enrichMock = vi.fn()

beforeEach(() => {
  enrichMock.mockReset()
  ;(window as unknown as { hive: unknown }).hive = { github: { enrichPrs: enrichMock }, shell: { openExternal: vi.fn() } }
})
afterEach(cleanup)

describe('PRsView enrichment', () => {
  it('renders live state, checks, diffstat and review chips when enriched', async () => {
    enrichMock.mockResolvedValue({
      [CARD.url]: {
        state: 'open', isDraft: true, additions: 12, deletions: 4,
        reviewDecision: 'changes-requested', checks: 'failing',
      },
    })
    render(<PRsView prs={[CARD]} projectLabel="proj" />)
    await waitFor(() => expect(screen.getByText('+12')).toBeDefined())
    expect(enrichMock).toHaveBeenCalledWith([CARD.url])
    expect(screen.getByText('−4')).toBeDefined()
    expect(screen.getByText(/draft/i)).toBeDefined()
    expect(screen.getByText(/checks failing/i)).toBeDefined()
    expect(screen.getByText(/changes requested/i)).toBeDefined()
  })

  it('falls back to story-derived rendering and a hint when enrichment is all-null', async () => {
    enrichMock.mockResolvedValue({ [CARD.url]: null })
    render(<PRsView prs={[CARD]} projectLabel="proj" />)
    await waitFor(() =>
      expect(screen.getByText(/Live GitHub status unavailable/i)).toBeDefined(),
    )
    expect(screen.queryByText('+12')).toBeNull()
  })

  it('renders plainly when the github bridge is absent', () => {
    ;(window as unknown as { hive: unknown }).hive = { shell: { openExternal: vi.fn() } }
    render(<PRsView prs={[CARD]} projectLabel="proj" />)
    expect(screen.getByText('Ship it')).toBeDefined()
    expect(screen.queryByText(/unavailable/i)).toBeNull()
  })
})
```

Run → FAIL.

- [ ] **Step 2: implement.** In `PRsView.tsx`:
- Add state + effect:

```tsx
  const [enrichment, setEnrichment] = useState<Record<string, PrEnrichment | null>>({})
  const [hint, setHint] = useState(false)
  const urlsKey = prs.map((p) => p.url).join('\n')

  useEffect(() => {
    const bridge = window.hive?.github
    if (!bridge || prs.length === 0) return
    let cancelled = false
    void bridge
      .enrichPrs(prs.map((p) => p.url))
      .then((map) => {
        if (cancelled) return
        setEnrichment(map)
        setHint(Object.values(map).every((v) => v === null))
      })
      .catch(() => {
        if (!cancelled) setHint(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlsKey])
```

(Import `PrEnrichment` from `../../../types/github`; `useEffect`/`useState` from react.) A header "Refresh" `Btn kind="outline" icon="refresh-cw"` re-runs the same fetch (extract the fetch into a `useCallback` used by both; title: "Re-check GitHub (results cached ~60s)").
- Per-card, `const live = enrichment[pr.url]`; when `live` is non-null render, in the existing meta row's style:
  - `StatusChip status={live.state === 'open' ? 'review' : live.state}` — CHECK StatusChip's accepted statuses first (`src/renderer/src/components/primitives`); if it only knows review/merged, render `open`/`closed` with the closest token or a small inline chip span copying `.req-pill` styling. Keep the story-derived chip when `live` is null.
  - `{live.isDraft && <span className="meta-mono">Draft</span>}`
  - `<span style={{ color: 'var(--diff-add-fg)' }}>+{live.additions}</span> <span style={{ color: 'var(--diff-del-fg)' }}>−{live.deletions}</span>`
  - checks pill: `checks passing|failing|pending` colored `var(--status-done)` / `var(--diff-del-fg)` / `var(--status-pending)`; hidden when null.
  - review chip: `approved` / `changes requested` / `review required`; hidden when null.
- Hint line under the header when `hint && prs.length > 0`: `Live GitHub status unavailable — sign in with gh or set github.token in Settings.` (muted, `.sub`-like style).
- Update the file header comment.

Run the component test → PASS (3). Also `npx vitest run src/renderer/src/` for regressions.

- [ ] **Step 3: commit**

```bash
git add src/renderer/src/components/PRsView.tsx src/renderer/src/components/PRsView.test.tsx
git commit -m "feat(prs): live GitHub enrichment on PR cards (state, checks, diffstat, review)"
```

---

## Task 5: Full verification + PR

- [ ] **Step 1:** `npm run typecheck && npx vitest run` → all green (~789 + new). `npm run build && npx playwright test` ×3 → 11/11 each (the PRs e2e test exercises the no-credential path: CI/gh-less envs must not regress; locally gh IS authed — the e2e fixture's `https://github.com/o/r/pull/77` will 404 → nulls → unchanged rendering, which also proves failure-collapse. If the e2e test flakes on the hint line appearing, the hint must not break existing assertions — adjust the hint's placement, not the test).
- [ ] **Step 2:** Push + PR:

```bash
gh auth switch --user nikrich
git push -u origin HEAD:feat/prs-github-enrichment
gh pr create --repo nikrich/hive-ide --base main --head feat/prs-github-enrichment \
  --title "feat(prs): live GitHub enrichment for PR cards" \
  --body "<summary: batched GraphQL, gh-CLI/settings token, 60s cache, graceful degradation; spec link; test counts>"
```

Watch CI (`gh pr checks --watch`): the e2e job now also validates the degradation path with zero GitHub credentials.

---

## Self-Review (completed during authoring)

- **Spec coverage:** parse/query/map + cache + token (T1-T3), settings key (T2), IPC/preload (T3), PRsView UI + hint + Refresh (T4), testing matrix incl. e2e degradation (T5). All spec sections map.
- **Placeholders:** the two "read the real API first" notes (SettingsStore getter name, StatusChip statuses) are verification instructions against named files with fallback behavior specified — not TBDs.
- **Type consistency:** `PrEnrichment` defined once in `src/types/github.ts`, consumed in enrich.ts/api.ts/PRsView; `EnrichDeps {fetchFn,getToken,now}` consistent between Task 3 code and tests; `resolveToken(settingsToken, exec)` matches its tests; channel `ipc:hive:github:enrich-prs` consistent across handler/preload.
