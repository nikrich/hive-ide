# Hive native orchestration — Slice 2b-2: Manager LLM (repo indexing + requirement decomposition)

**Date:** 2026-06-09
**Status:** Approved (design), pending implementation plan
**Track:** Native hive orchestration in the IDE (slice 2 of 4 — the manager sub-slice)

## Context

Shipped so far:
- **Slice 1** — read-only state viewer (`.hive/state/**` + watcher → Dock board / log).
- **Slice 2a** — run one worker on a story (Run → `claude` worker in an isolated worktree → reap → write state). Re-run idempotent.
- **Slice 2c** — UI workspace bootstrap + story authoring; team-aware repo resolution (`resolveRepoForStory`).
- **Slice 2b-1** — autonomous run loop (Start/Stop tick auto-runs `pending` stories serially) + the question → `needs-input` → notify → answer → re-run flow.

Today a human authors every story by hand and the loop runs whatever is `pending`. The **manager LLM** — the piece that turns a high-level *requirement* into routed stories — is unbuilt. The user's standing ask (from 2c): *"we should not be selecting the repo; hive should determine where the work should be done."* This slice delivers that: hive decides **what** (decompose) and **where** (route).

The 2b-1 spec deliberately left this seam open: *"The manager LLM plugs in as the producer of `pending` stories — the loop already consumes them, so the manager slots in with no loop change."* This slice fills that seam.

## Key decisions (settled in brainstorming)

- **One-shot decomposition per requirement**, not a persistent in-loop manager. You author a requirement; the manager runs **once** to produce stories. A persistent continuously-reasoning manager, and re-planning on completion, are later slices (re-planning depends on slice 4 knowing when stories are *truly* done).
- **Index repos at add-time, route from the cache.** When a repo is added, hive runs a one-time **indexer** that writes a compact profile to `.hive/index/<repo>.md`. The manager routes from these cached profiles, so each decompose stays cheap *and* well-informed. This fulfils "hive determines where the work runs."
- **Indexer + manager are `claude` runs, but read-only analysts.** Unlike workers (which edit an isolated worktree and commit), these runs **only read**; their final text output is captured and **hive performs all file writes**. This keeps them safe (no write mandate) and testable (hive owns the writes, validated).
- **Two lanes, no within-lane concurrency.** The existing single-active worker runner is unchanged ("worker lane"). A second `createRunner()` instance + a small FIFO queue forms the "manager lane". Worker and manager runs may overlap (different lanes); index/decompose run one at a time within the manager lane.
- **Proposed → approve gate.** Decomposed stories land as **`proposed`**, grouped under their requirement. You review routing/criteria, edit/delete, then **Approve plan** flips them to `pending` for the loop. A real checkpoint before any worker spawns.
- **Build as two sub-slices, one spec.** **2b-2a — Indexing** (independently useful) then **2b-2b — Decomposition** (reads the profiles). Each is a working, testable increment.

## Architecture

Two new event-triggered agent activities that *produce* work the existing loop *consumes*:

1. **Indexer** — triggered on repo add / project connect / app-start for `unindexed` repos. Reads the repo (README, structure, manifests, entry points), emits a profile. Hive writes `.hive/index/<repo>.md`.
2. **Manager** — triggered on requirement creation. Reads all repo profiles + the requirement, emits a structured plan (stories, each routed to a repo). Hive validates and writes `proposed` story files.

### New main modules — `src/main/hive/manager/`

- `requirement.ts` — `createRequirement` (write `.hive/state/requirements/<id>.md` + `created` event), `serializeRequirement`.
- `profile.ts` — `serializeProfile`, `readProfiles(indexDir): Promise<RepoProfile[]>`.
- `indexer.ts` — `buildIndexPrompt(repo)`; the run's result text *is* the profile body → hive writes the profile file.
- `decompose.ts` — `buildDecomposePrompt(requirement, profiles)`; `parsePlan(resultText): ManagerPlan` (+ validation); writer that fans the plan into `proposed` stories and sets the requirement `decomposed`.
- `approve.ts` — `approvePlan(workspacePath, reqId, now)`: flip the requirement's `proposed` stories → `pending`, requirement → `in-flight`, append `approved` event. `discardPlan(workspacePath, reqId, now)`: delete the requirement's `proposed` stories + the requirement file, append an `abandoned` event (a rejected plan leaves no trace for the loop to run).
- `lane.ts` — the **manager lane**: a second `createRunner()` instance + a FIFO job queue (so connecting a project with N repos enqueues N index jobs that run serially without colliding).

### Minor runner extension — `src/main/hive/run/runner.ts`

Add an optional `onResult(text: string)` to `RunnerEvents`, captured from the stream-json `type:"result"` message in the existing line loop. This is how the manager lane gets the agent's final text (the profile / the plan). Worker runs simply don't pass `onResult`. No behavioural change to existing worker runs.

## Data model

### A. Status lifecycle changes — `src/types/hive.ts` + `parse.ts`

- `StoryStatus` += **`'proposed'`** — add to the union **and** the `STORY_STATUSES` array (the 2b-1 lesson: update both or the parser coerces unknown values to `pending`). Lifecycle: `proposed → (approve) → pending → …` existing flow.
- `RequirementStatus` += **`'decomposing'`** — add to the union **and** `REQ_STATUSES` in `parse.ts`. Full lifecycle:
  `pending → decomposing → decomposed → in-flight → complete | blocked`
  (created → manager running → stories proposed → plan approved → … → done; `blocked` = decompose failed).

### B. New types — `src/types/hive.ts`

```ts
/** A repo's indexed profile — .hive/index/<repo>.md */
export interface RepoProfile {
  repo: string;        // = filename stem = repo (team) name
  indexedAt: string;
  commit?: string;     // sha the profile was built from
  body: string;        // NL profile: purpose, stack, key dirs, test cmd
}

export type IndexStatus = 'unindexed' | 'indexing' | 'indexed' | 'failed';

/** New-requirement form fields (renderer ↔ preload ↔ main). */
export interface NewRequirementFields {
  title: string;
  body: string;
}

/** One story the manager proposes; hive validates + writes it. */
export interface ProposedStory {
  title: string;
  body: string;
  team: string;             // repo name to route to
  role: HiveRole;
  acceptanceCriteria: string[];
}
export interface ManagerPlan {
  stories: ProposedStory[];
}

/** Manager-lane run status pushed to the renderer. */
export interface HiveManagerStatusEvent {
  activity: 'indexing' | 'decomposing';
  target: string;           // repo name | requirement id
  status: 'starting' | 'running' | 'exited';
  outcome?: 'success' | 'failure';
  detail?: string;
}
```

### C. File contracts (all under the workspace; files are the single source of truth)

1. **Repo profile** — `.hive/index/<repo>.md` *(new kind; written by hive from the indexer's result text, not by the agent)*:
   ```
   ---
   repo: bff-web
   indexed_at: 2026-06-09T16:40:00Z
   commit: abc1234
   ---
   Purpose: customer-facing web BFF. Stack: TypeScript, Lambda handlers…
   Key areas: src/.../handlers (endpoints), … Test: `npm test`.
   ```
2. **Requirement** — `.hive/state/requirements/<id>.md` *(already parsed by slice 1; this slice **writes** it via a new `serializeRequirement`)*. Body = the high-level description; `decomposed_into` lists the proposed story ids.
3. **Proposed story** — `.hive/state/stories/<id>.md`, **same schema as today** with `status: proposed`, `parent_requirement: <reqId>`, `team: <repo>`. No new story-file fields — reuses `serializeStory`; `parseStory` already reads `parent_requirement` + `team`.

### D. The plan contract (manager output → hive)

The manager agent emits a single fenced ```json block matching `ManagerPlan`. Hive captures the run's final result text, extracts the JSON, validates each story, and writes them as `proposed`.

**Routing validation:** if a story's `team` is not a repo in the project, hive **keeps** the story but flags it (a "repo not found — will fall back" badge in the review), rather than hard-failing — you fix it at the approval gate. At run time, `resolveRepoForStory` falls back to the first repo for an unknown team, so a missed flag never wedges a run.

**Parse failure** (no JSON block / malformed / empty `stories`) → requirement `blocked` + a `failed` event with detail. No stories written. No silent failure.

### E. New events (`events.ndjson`)

`indexed` (actor `manager`, detail repo), `decomposed` (actor `manager`, detail reqId), `approved` (actor `user`, detail reqId), and `failed` (actor `manager`, detail repo|reqId + reason) for either run.

### F. Routing

`resolveRepoForStory(team, repos)` is unchanged. The manager simply sets `team` intelligently using the profiles; existing run + loop honour it.

## Data flow

**Flow 1 — Indexing**
```
repo added / project connected / app start (unindexed repos)
  → enqueue index job → manager lane runs `claude` (cwd = repo, read-only)
  → onResult(profileText) → write .hive/index/<repo>.md, `indexed` event
  → push manager status (indexing → exited); renderer shows "indexed ✓"
```

**Flow 2 — Decompose → review → approve**
```
"+ New requirement" (title + body) → createRequirement (status pending)
  → enqueue decompose job → requirement → decomposing
  → manager run (cwd = workspace) reads .hive/index/* + the requirement
  → onResult(jsonPlan) → parse + validate
      → write N `proposed` stories (parent_requirement set, team routed),
        requirement → decomposed, `decomposed` event
  → board shows the requirement with its proposed stories grouped beneath
  → you review (each story: role + routed repo, ⚠ badge if repo unknown), edit/delete
  → "Approve plan" → approvePlan: stories → pending, requirement → in-flight
  → the existing 2b-1 loop runs them (routing honours team)
```

The slice-1 watcher renders every board/log change; 2b-2 adds the requirement + proposed surface and the index-status surface; the manager status push drives a small spinner.

## IPC + main wiring

New channels (mirroring the existing `run`/`loop` bridges):

| Channel | Dir | Payload |
|---|---|---|
| `ipc:hive:requirement:create` | r→m invoke | `NewRequirementFields` → `string` (reqId) |
| `ipc:hive:requirement:approve` | r→m invoke | `{ reqId }` → `void` |
| `ipc:hive:requirement:discard` | r→m invoke | `{ reqId }` → `void` |
| `ipc:hive:repo:reindex` | r→m invoke | `{ repo }` → `void` |
| `ipc:hive:index:status` | r→m invoke | `{}` → `Record<string, IndexStatus>` |
| `event:hive:manager:status` | m→r push | `HiveManagerStatusEvent` |

`index.ts` builds the manager lane (second runner + FIFO queue), wires `createRequirement`/`approvePlan`/indexer/decompose to it, derives per-repo `IndexStatus` (profile file present → `indexed`; in-flight job → `indexing`; last job failed → `failed`; else `unindexed`), auto-enqueues indexing for `unindexed` repos on connect/start, and on quit reaps the manager child and resets stale `decomposing`/`indexing` state.

## Preload + renderer

- Preload: `window.hive.requirement.{ create, approve }`, `window.hive.repo.reindex`, `window.hive.index.status`, and `window.hive.manager.onStatus`, mirroring existing bridges.
- **+ New requirement** button → a modal (title + description) mirroring `NewStoryModal`.
- **Requirement card** on the board: status pill (`decomposing` spinner / `decomposed` / `in-flight`); when `decomposed`, its `proposed` stories render grouped beneath, each showing role + routed repo (⚠ badge if the repo is unknown), with **Approve plan** and **Discard** actions.
- **Index status** in the repo list: per repo `indexed ✓ / indexing… / failed ↻`, plus a manual **Re-index** action.

## Error handling

- **Indexer fails** (non-zero / spawn error / empty result) → `IndexStatus failed`, `failed` event; the repo is still routable name-only. Re-index available.
- **Decompose fails / unparseable plan** → requirement → **`blocked`**, `failed` event with detail, no stories written. Re-run decompose or edit the requirement.
- **Story routed to an unknown repo** → soft-flagged at the approval gate, not a hard fail (and `resolveRepoForStory` falls back at run time).
- **Zero repos in the project** → decompose can't route → requirement `blocked` ("no repos to route to").
- **Manager lane busy** → jobs queue (FIFO); never dropped.
- **No workspace connected** → create/approve/reindex are no-ops (the UI only offers them when connected).
- **Quit mid-run** → reap the child (existing worker pattern). On next start, a stale `decomposing` requirement resets to `pending`; a stale `indexing` repo resets to `unindexed`. Retry-able, never wedged.

## Testing

- **Pure (Vitest):** `profile` parse/serialize round-trip; `decompose` `parsePlan` + validation (valid JSON; malformed → blocked; unknown `team` → flagged; empty `stories` → blocked); `requirement` serialize; `approvePlan` flips the requirement's proposed stories → pending and the requirement → in-flight; new-enum coercion (`proposed` / `decomposing` survive `parseStory` / `parseRequirement`); `buildIndexPrompt` / `buildDecomposePrompt` builders.
- **Runner extension (Vitest, fake stream):** `onResult` is called with the `type:"result"` text; worker runs without `onResult` are unaffected.
- **Manager lane (Vitest, injected spawn + schedule):** FIFO runs jobs serially; a job enqueued while busy waits its turn; the failure path marks state + emits a `failed` event.
- **hiveView / board adapter (Vitest):** `proposed` stories group under their parent requirement; `decomposing` requirement renders as in-progress.
- **Manual:** connect a project with ≥2 repos → repos auto-index → profiles appear → "indexed ✓". Create a requirement spanning both repos → the manager proposes routed `proposed` stories under the requirement → review (confirm routing, see a ⚠ on a deliberately bad team) → **Approve plan** → the 2b-1 loop runs each story in the correct repo. Kill the app mid-decompose → on restart the requirement is back to `pending`.

## Forward compatibility (full orchestration)

- **Re-planning on completion** (a later slice) hooks the same `decompose` module, re-triggered when a requirement's stories all reach `merged` — which needs **slice 4** (QA / merge) to define "done".
- **Concurrency** within the worker lane (1→N active) is still the isolated runner change described in 2b-1; the manager lane is independent of it.
- **Dependency-aware scheduling** — the manager may already *emit* `dependsOn` between stories; the loop continues to run `pending` serially in creation order until a later slice honours dependencies.
- **Acceptance-criteria verification (slice 4)** — the manager populates each story's `acceptanceCriteria`; the `review` state remains the hand-off point into the `/goal`-style QA check.

## Out of scope (later slices)

- A persistent, continuously-reasoning manager; re-planning on completion (needs slice 4).
- Auto re-indexing on code change (manual re-index only here).
- Concurrency within a lane; dependency-aware scheduling.
- QA / merge / PR surfacing + actions (slice 4); semantic memory.
