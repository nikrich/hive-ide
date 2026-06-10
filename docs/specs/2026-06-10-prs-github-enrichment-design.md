# PRs View — GitHub Enrichment — Design

**Date:** 2026-06-10
**Status:** Approved (brainstormed in-session)
**Scope:** PR 2 of 3 (e2e suite ✅ #57 → **this** → audit-driven UI polish).

## Goal

Enrich the PRs view's live cards (derived from story `prUrl` since #54) with real GitHub data — PR state + draft, checks rollup, +/− diff stats, review decision — fetched in the main process, batched into one request, and degrading gracefully to today's behavior when no credential or network is available.

## Decisions (user-confirmed)

- **Auth:** `gh auth token` via `execFile` (zero-config; the dev machine is gh-authed), overridden by a new `github.token` settings key; no credential → enrichment silently off.
- **Timing:** fetch when the PRs view opens / its card list changes; 60s per-URL cache in main; manual Refresh button bypasses staleness by re-invoking (cache honored — see Caching).
- **Fields:** `state` (OPEN/MERGED/CLOSED) + `isDraft`, `additions`/`deletions`, `reviewDecision`, checks rollup state.
- **Batching:** one GraphQL request for all visible PRs (aliased repository/pullRequest blocks), not N REST calls.

## Architecture

### Main process — new `src/main/github/`

- `enrich.ts` (pure parts kept side-effect-free for unit tests):
  - `parsePrUrl(url)` → `{ owner, repo, number } | null`. Strictly `https://github.com/<owner>/<repo>/pull/<number>` (optional trailing slash). Anything else (GitLab, GH Enterprise hosts, malformed) → null → card stays unenriched.
  - `buildPrQuery(refs)` → GraphQL query string with one alias per PR: `state isDraft additions deletions reviewDecision` + `commits(last:1){nodes{commit{statusCheckRollup{state}}}}`.
  - `mapPrResponse(refs, json)` → `Record<url, PrEnrichment | null>`, defensive per-alias (a single 404'd repo nulls only its own entry via GraphQL partial-data + errors array).
  - `enrichPrs(urls, deps)` — orchestration with injected `{ fetchFn, getToken, now }` for tests: dedupe URLs, serve from a 60s in-memory cache, batch the misses into one POST to `https://api.github.com/graphql` with the plugins-module fetch hygiene (timeout, `redirect: 'error'`; response size is bounded by our scalar-only query against the hardcoded api.github.com host — no streamed byte ceiling needed), merge into the cache, return the full map. Any transport/auth failure → all-misses map to null (never throws to the caller).
- `token.ts`: `resolveToken(settings)` — `settings['github.token']` if non-empty, else `execFile('gh', ['auth', 'token'])` (trimmed; non-zero exit or missing binary → null), memoized for the process lifetime; `_resetTokenCache()` test hook.
- `handlers.ts`: `ipc:hive:github:enrich-prs` — validates `urls: string[]`, resolves the token (null → returns all-null map immediately), calls `enrichPrs`. Registered/torn down like sibling handler modules.

`PrEnrichment` (in `src/types/github.ts`, shared main↔preload↔renderer):

```typescript
export interface PrEnrichment {
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  additions: number;
  deletions: number;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED → normalized, or null. */
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null;
  /** SUCCESS | FAILURE | ERROR | PENDING/EXPECTED → normalized, or null when no checks. */
  checks: 'passing' | 'failing' | 'pending' | null;
}
```

### Settings

`github.token: string` added to `Settings` + `DEFAULT_SETTINGS` (`''`). Plaintext in settings.json — acceptable: it's an explicit opt-in override; the primary path (gh keychain) never touches disk. The token never crosses to the renderer.

### Preload

`window.hive.github.enrichPrs(urls: string[]): Promise<Record<string, PrEnrichment | null>>` — standard invoke passthrough.

### Renderer — PRsView owns enrichment; `PrCard`/`toPrCards` untouched

- Component state: `enrichment: Record<string, PrEnrichment | null>`, `fetching: boolean`.
- Effect: when the view mounts or the `prs` URL set changes, call the bridge (fire-and-forget with abort-on-unmount semantics via a cancelled flag). A "Refresh" `Btn` in the header re-invokes (main's 60s cache keeps this cheap; a refresh inside the window is a no-op by design — documented in the button's title).
- Rendering per card, only when its enrichment is non-null:
  - State chip from the API (`open`/`merged`/`closed`) replaces the story-derived chip; `Draft` badge when `isDraft`.
  - Checks pill: passing (green) / failing (red) / pending (amber); hidden when `checks` null.
  - `+N −M` in the existing meta-mono style.
  - Review-decision chip: approved / changes requested / review required; hidden when null.
- Cards with null enrichment render exactly as today. When the bridge returns all-null AND there were URLs to enrich, show one muted hint line under the header: "Live GitHub status unavailable — sign in with `gh` or set github.token in Settings." No spinners over the list; no error banners.

## Error handling

- Main: every failure mode (no token, gh missing, network down, GraphQL errors, rate-limited, malformed response) collapses to `null` enrichment values; one `console.warn` in main for diagnosability. The handler never rejects for data reasons (only for a malformed `urls` argument).
- Renderer: treats the map as display-only; absence of a key = null.

## Testing

- Vitest (main): `parsePrUrl` (happy + GitLab/enterprise/malformed), `buildPrQuery` alias shape, `mapPrResponse` (full, partial-error, garbage), cache TTL via injected `now`, `resolveToken` order (settings beats gh; gh failure → null) with mocked `execFile`.
- Vitest (renderer): PRsView with a mocked bridge — enriched card shows checks/diffstat/review chips; null map shows the hint; bridge absence (window.hive.github undefined) renders like today.
- E2E: the existing PRs-view test keeps passing unchanged — CI has no gh auth, which pins the graceful-degradation path. No live-API e2e (non-hermetic).

## Out of scope

- Background polling / rail badges; GH Enterprise hosts; PR list sourced from GitHub (cards still originate from story `prUrl`); writing the token from the UI (settings.json editing already exists).
