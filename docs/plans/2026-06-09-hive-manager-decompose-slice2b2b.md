# Hive Manager LLM — Slice 2b-2b (Requirement Decomposition + Approval) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Depends on:** Slice 2b-2a (`docs/plans/2026-06-09-hive-manager-indexing-slice2b2a.md`) — the manager lane, `onResult`, `readProfiles`, and `HIVE_MANAGER_CHANNELS` must exist first.

**Goal:** Let an operator author a high-level requirement that a read-only `claude` manager run decomposes into N routed `proposed` stories, which the operator reviews and then approves (→ `pending`, picked up by the 2b-1 loop) or discards.

**Architecture:** A "+ New requirement" modal writes a `pending` requirement file and enqueues a `decompose` job on the manager lane (the second `claude` runner built in 2b-2a). The decompose job flips the requirement to `decomposing`, runs `claude` read-only over the cached `.hive/index/*` profiles + the requirement, captures its final text via `onResult`, parses+validates the JSON plan, and writes N `proposed` stories grouped under the requirement (requirement → `decomposed`). The operator Approves (stories → `pending`, requirement → `in-flight`) or Discards (delete proposed stories + requirement). Files remain the single source of truth; the agent never writes — hive owns every write.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React, Zustand, Vitest (node env for main, happy-dom for renderer), yaml.

---

## Assumed 2b-2a surface (this plan ADDS to it; do not re-create)

These exist from 2b-2a and are referenced verbatim below. If a worker finds a name drift, reconcile to these signatures:

- `src/main/hive/run/runner.ts` — `RunnerEvents` carries an optional `onResult?: (text: string) => void`, fired from the stream-json `type:"result"` message with the raw `result` string. `RunSpec` + `Runner` are reused by the manager lane.
- `src/main/hive/manager/lane.ts` — a **generic** FIFO manager lane. It is NOT edited by 2b-2b. A job is fully described by its callbacks — the lane has NO knowledge of `'index'` vs `'decompose'` and never switches on a `kind` field. Exact surface:

  ```ts
  /** One unit of manager-lane work. Generic over kind via its callbacks. */
  export interface ManagerJob {
    activity: HiveManagerStatusEvent['activity'];        // 'indexing' | 'decomposing'
    target: string;                                       // repo name | requirement id
    buildSpec: (runId: string) => RunSpec;                // builds the claude RunSpec (cwd, prompts)
    onResult: (text: string) => void | Promise<void>;     // clean exit + non-empty result
    onFailure: (detail: string) => void | Promise<void>;  // non-zero exit / spawn error / empty result
  }

  export interface ManagerJobRef { activity: HiveManagerStatusEvent['activity']; target: string; }

  export interface ManagerLane {
    enqueue(job: ManagerJob): void;
    current(): ManagerJobRef | null;   // active job, or null
    queued(): ManagerJobRef[];         // waiting jobs
    isBusy(): boolean;
    dispose(): Promise<void>;          // stop active run + clear queue (before-quit)
  }

  export function createManagerLane(deps: {
    createRunner?: () => Runner;
    onStatus: (e: HiveManagerStatusEvent) => void;
    now: () => string;
    newRunId: () => string;
  }): ManagerLane;
  ```

  Internally the lane's `pump()` shifts the queue, calls `runner.start(job.buildSpec(runId), {...})`, captures `onResult` text, and on exit decides failure (`r.code !== 0 || r.signal !== null || result empty`) → `job.onFailure(detail)` else `job.onResult(result)`, emits a `HiveManagerStatusEvent` via `deps.onStatus`, then pumps the next. **Note:** the lane only routes process-level failures to `onFailure`; a throw *inside* `onResult` (e.g. a parse error) is the job's own responsibility — see Task 6.
- `src/main/hive/manager/profile.ts` — `readProfiles(indexDir: string): Promise<RepoProfile[]>`.
- `src/main/hive/manager/handlers.ts` — `HIVE_MANAGER_CHANNELS` (2b-2a added `reindex`/`indexStatus` + the manager-status event) and `registerHiveManagerHandlers(deps)` returning a teardown fn.
- `src/types/hive.ts` — `RepoProfile`, `IndexStatus`, `HiveManagerStatusEvent` already added.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/types/hive.ts` | Modify | Add `'proposed'` to `StoryStatus` + `STORY_STATUSES`; add `'decomposing'` to `RequirementStatus`; add `NewRequirementFields`, `ProposedStory`, `ManagerPlan` interfaces. |
| `src/main/hive/parse.ts` | Modify | Add `'decomposing'` to `REQ_STATUSES` so `parseRequirement` keeps it. |
| `src/main/hive/parse.test.ts` | Modify | Regression: `proposed` (story) + `decomposing` (requirement) survive parsing. |
| `src/main/hive/manager/requirement.ts` | Create | `serializeRequirement`; `createRequirement(ws, fields, now)` → write `.hive/state/requirements/<id>.md` (status `pending`) + `created` event. |
| `src/main/hive/manager/requirement.test.ts` | Create | Round-trip + writer temp-dir tests. |
| `src/main/hive/manager/decompose.ts` | Create | `buildDecomposeSystemPrompt`, `buildDecomposePrompt`, `parsePlan` (+ `PlanParseError`), `writeProposedStories`, and `buildDecomposeJob` (returns a generic `ManagerJob`). |
| `src/main/hive/manager/decompose.test.ts` | Create | Prompt builders, parse/validation, writer (incl. unknown-team flag), and the `buildDecomposeJob` factory (direct + lane integration). |
| `src/main/hive/manager/approve.ts` | Create | `approvePlan(ws, reqId, now)`, `discardPlan(ws, reqId, now)`. |
| `src/main/hive/manager/approve.test.ts` | Create | Temp-dir fs tests for approve + discard. |
| `src/main/hive/manager/handlers.ts` | Modify | Add `createRequirement`/`approve`/`discard` channels + deps. |
| `src/main/index.ts` | Modify | Wire `createRequirement`/`approve`/`discard`; enqueue decompose jobs; stale-`decomposing` reset on start. |
| `src/preload/api.ts` | Modify | Add `requirement` bridge to `HiveBridge`; re-export `NewRequirementFields`. |
| `src/preload/index.ts` | Modify | Implement the `requirement` bridge; add channel strings. |
| `src/renderer/src/components/NewRequirementModal.tsx` | Create | Title + description modal → `window.hive.requirement.create`. |
| `src/renderer/src/lib/hiveView.ts` | Modify | `toRequirementCards` adapter grouping `proposed` stories under requirements. |
| `src/renderer/src/lib/hiveView.test.ts` | Modify | Tests for the grouping adapter. |
| `src/renderer/src/components/AgentDock.tsx` | Modify | "+ New requirement" trigger + Requirement cards (status pill, proposed stories, Approve/Discard). |
| `src/renderer/src/styles/ide.css` | Modify | Requirement-card CSS matching the Dock styles. |

---

## Task 1: Status-enum additions + parse regression (BOTH-PLACES rule)

> **CRITICAL — the 2b-1 lesson:** A status value must be added in **two** places or the parser silently coerces it. `'proposed'` goes in the `StoryStatus` union **and** the `STORY_STATUSES` array (else `parseStory` → `pending`). `'decomposing'` goes in the `RequirementStatus` union **and** the `REQ_STATUSES` array in `parse.ts` (else `parseRequirement` → `pending`). This task proves both with a regression test before any writer relies on them.

**Files:**
- Modify: `src/types/hive.ts`, `src/main/hive/parse.ts`
- Test: `src/main/hive/parse.test.ts`

- [ ] **Step 1: Write the failing regression test.** In `src/main/hive/parse.test.ts`, inside the existing `describe('parseStory', …)` block add:

```ts
  it('keeps the proposed status (does not coerce to pending)', () => {
    const s = parseStory('---\ntitle: X\nstatus: proposed\nrole: senior\n---\n', 'S-prop')
    expect(s.status).toBe('proposed')
  })
```

  And inside the existing `describe('parseRequirement', …)` block add:

```ts
  it('keeps the decomposing status (does not coerce to pending)', () => {
    const r = parseRequirement('---\ntitle: Y\nstatus: decomposing\n---\n', 'REQ-dec')
    expect(r.status).toBe('decomposing')
  })
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/main/hive/parse.test.ts` — both new cases fail (`proposed` → `pending`, `decomposing` → `pending`) because the arrays don't include them yet.

- [ ] **Step 3: Add `'proposed'` to the `StoryStatus` union.** In `src/types/hive.ts`, edit the union:

```ts
export type StoryStatus =
  | 'pending'
  | 'proposed'
  | 'assigned'
  | 'in-progress'
  | 'review'
  | 'merged'
  | 'blocked'
  | 'abandoned'
  | 'needs-input';
```

- [ ] **Step 4: Add `'proposed'` to `STORY_STATUSES`.** In the same file, edit the array:

```ts
/** The valid story statuses (for parse-time coercion). */
export const STORY_STATUSES: readonly StoryStatus[] = [
  'pending',
  'proposed',
  'assigned',
  'in-progress',
  'review',
  'merged',
  'blocked',
  'abandoned',
  'needs-input',
];
```

- [ ] **Step 5: Add `'decomposing'` to the `RequirementStatus` union.** In `src/types/hive.ts`:

```ts
export type RequirementStatus =
  | 'pending'
  | 'decomposing'
  | 'decomposed'
  | 'in-flight'
  | 'complete'
  | 'blocked';
```

- [ ] **Step 6: Add `'decomposing'` to `REQ_STATUSES`.** In `src/main/hive/parse.ts` (the `REQ_STATUSES` const around line 30):

```ts
const REQ_STATUSES: readonly RequirementStatus[] = [
  'pending',
  'decomposing',
  'decomposed',
  'in-flight',
  'complete',
  'blocked',
];
```

- [ ] **Step 7: Run — expect PASS.** `npx vitest run src/main/hive/parse.test.ts` — both regression cases pass.

- [ ] **Step 8: Commit.**

```bash
git add src/types/hive.ts src/main/hive/parse.ts src/main/hive/parse.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): add proposed/decomposing statuses to enum + arrays

proposed (StoryStatus) and decomposing (RequirementStatus) must be in
both the union and the coercion array or parse silently downgrades them.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: New manager data-model types

**Files:**
- Modify: `src/types/hive.ts`
- Test: covered indirectly by Tasks 3–5 (these are pure interfaces; no standalone test).

- [ ] **Step 1: Add the three interfaces.** In `src/types/hive.ts`, after the `HiveQuestion` interface (end of the 2b-1 block), append:

```ts
// ---------------------------------------------------------------------------
// Slice 2b-2b — requirement decomposition + approval
// ---------------------------------------------------------------------------

/** New-requirement form fields (renderer ↔ preload ↔ main). */
export interface NewRequirementFields {
  title: string;
  /** High-level description / markdown body. */
  body: string;
}

/** One story the manager proposes; hive validates + writes it as `proposed`. */
export interface ProposedStory {
  title: string;
  body: string;
  /** Repo (team) name to route to. */
  team: string;
  role: HiveRole;
  acceptanceCriteria: string[];
}

/** The manager's decompose output, after parse + validation. */
export interface ManagerPlan {
  stories: ProposedStory[];
}
```

  > Note: `RepoProfile`, `IndexStatus`, `HiveManagerStatusEvent` already exist from 2b-2a — do not re-add them.

- [ ] **Step 2: Typecheck.** `rm -f *.tsbuildinfo && npm run typecheck` — clean (no unused-symbol or duplicate errors).

- [ ] **Step 3: Commit.**

```bash
git add src/types/hive.ts
git commit -m "$(cat <<'EOF'
feat(hive): add NewRequirementFields, ProposedStory, ManagerPlan types

Shared shapes for the requirement-decomposition flow (renderer ↔ preload
↔ main). RepoProfile/IndexStatus/HiveManagerStatusEvent come from 2b-2a.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `requirement.ts` — serialize + create

Mirror `serializeStory` (`run/serialize.ts`) and `createStory` (`run/story.ts`): snake_case frontmatter that round-trips through `parseRequirement`, slugify + unique-id de-dupe, write the file, append a `created` event via `eventLine`.

**Files:**
- Create: `src/main/hive/manager/requirement.ts`
- Test: `src/main/hive/manager/requirement.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/main/hive/manager/requirement.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serializeRequirement, createRequirement } from './requirement';
import { parseRequirement } from '../parse';
import type { HiveRequirement } from '../../../types/hive';

function req(over: Partial<HiveRequirement> = {}): HiveRequirement {
  return {
    id: 'REQ-1', title: 'Add auth', status: 'pending',
    featureBranch: 'feat/auth', decomposedInto: ['S-1', 'S-2'],
    createdAt: '2026-06-09T00:00:00Z', updatedAt: '2026-06-09T01:00:00Z',
    body: 'Build auth.', ...over,
  };
}

describe('serializeRequirement round-trips through parseRequirement', () => {
  it('preserves the written fields', () => {
    const r = req();
    expect(parseRequirement(serializeRequirement(r), r.id)).toEqual(r);
  });

  it('omits absent optionals (round-trips to undefined, not null)', () => {
    const r = req({ featureBranch: undefined, decomposedInto: [] });
    expect(parseRequirement(serializeRequirement(r), r.id)).toEqual(r);
  });
});

describe('createRequirement', () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'hive-req-'));
    await mkdir(join(ws, '.hive', 'state', 'requirements'), { recursive: true });
    await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it('writes a pending requirement file + a created event, returns the id', async () => {
    const id = await createRequirement(ws, { title: 'Add OAuth login', body: 'Support Google.' }, 't0');
    expect(id).toBe('add-oauth-login');
    const r = parseRequirement(
      await readFile(join(ws, '.hive/state/requirements/add-oauth-login.md'), 'utf8'),
      id,
    );
    expect(r.status).toBe('pending');
    expect(r.title).toBe('Add OAuth login');
    expect(r.body).toBe('Support Google.');
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"created"');
    expect(events).toContain('"detail":"add-oauth-login"');
  });

  it('de-dupes the id on a slug clash', async () => {
    await createRequirement(ws, { title: 'Add login', body: 'x' }, 't0');
    const id2 = await createRequirement(ws, { title: 'Add login', body: 'y' }, 't1');
    expect(id2).toBe('add-login-2');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/main/hive/manager/requirement.test.ts` — module not found.

- [ ] **Step 3: Implement `requirement.ts`.** Create `src/main/hive/manager/requirement.ts`:

```ts
/**
 * Requirement authoring (slice 2b-2b): turn New-requirement form fields into a
 * slice-1 requirement file + a `created` event, and serialize a HiveRequirement
 * back to the on-disk format. Mirrors run/story.ts (slugify + unique id + write)
 * and run/serialize.ts (snake_case frontmatter that round-trips through parse).
 */

import { appendFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';

import type { HiveRequirement, NewRequirementFields } from '../../../types/hive';
import { eventLine } from '../run/serialize';
import { slugify, uniqueStoryId } from '../run/story';

/** Serialize a requirement to the slice-1 frontmatter `parseRequirement` reads. */
export function serializeRequirement(r: HiveRequirement): string {
  const data: Record<string, unknown> = {
    status: r.status,
    title: r.title,
    feature_branch: r.featureBranch,
    decomposed_into: r.decomposedInto,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringify(clean).trimEnd();
  const body = r.body.trim();
  return `---\n${yaml}\n---\n${body ? body + '\n' : ''}`;
}

/** Existing requirement ids (filename stems) under <ws>/.hive/state/requirements/. */
async function existingRequirementIds(workspacePath: string): Promise<Set<string>> {
  try {
    const names = await readdir(join(workspacePath, '.hive', 'state', 'requirements'));
    return new Set(names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
  } catch {
    return new Set();
  }
}

/**
 * Write a new `pending` requirement file (de-duped id) + append a `created`
 * event. Returns the new requirement id. Throws on fs failure (the handler
 * surfaces it).
 */
export async function createRequirement(
  workspacePath: string,
  fields: NewRequirementFields,
  now: string,
): Promise<string> {
  const existing = await existingRequirementIds(workspacePath);
  const id = uniqueStoryId(slugify(fields.title), existing);
  const requirement: HiveRequirement = {
    id,
    title: fields.title.trim(),
    status: 'pending',
    decomposedInto: [],
    createdAt: now,
    updatedAt: now,
    body: fields.body,
  };

  await writeFile(
    join(workspacePath, '.hive', 'state', 'requirements', `${id}.md`),
    serializeRequirement(requirement),
    'utf8',
  );
  await appendFile(
    join(workspacePath, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'user', event: 'created', detail: id, level: 'info' }) + '\n',
    'utf8',
  );
  return id;
}
```

  > `slugify`/`uniqueStoryId` are reused from `run/story.ts` (already exported there) — the slug base for `'Add login'` is `'add-login'`, so the clash test yields `'add-login-2'`.

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/main/hive/manager/requirement.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/manager/requirement.ts src/main/hive/manager/requirement.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): serializeRequirement + createRequirement (manager)

Writes a pending requirement file + a created event, mirroring story.ts;
round-trips through parseRequirement.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `decompose.ts` — prompts, plan parse/validate, proposed-story writer

The agent is a **read-only analyst**: it reads the requirement + cached repo profiles and outputs **only** a single fenced ```json block matching `ManagerPlan`. Hive captures the run's final text (the lane fires the job's `onResult`; the decompose job is built in Task 6), parses defensively, validates, and writes the `proposed` stories. Routing is **soft**: unknown `team` → still write the story, flag it. A bad/empty plan throws a typed `PlanParseError` which the job's `onResult` catches → marks the requirement `blocked`.

**Files:**
- Create: `src/main/hive/manager/decompose.ts`
- Test: `src/main/hive/manager/decompose.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/main/hive/manager/decompose.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDecomposeSystemPrompt,
  buildDecomposePrompt,
  parsePlan,
  PlanParseError,
  writeProposedStories,
} from './decompose';
import { serializeRequirement } from './requirement';
import { parseStory, parseRequirement } from '../parse';
import type { HiveRequirement, ManagerPlan, RepoProfile } from '../../../types/hive';
import type { Repo } from '../../../types/workspace';

const profiles: RepoProfile[] = [
  { repo: 'bff-web', indexedAt: 't', body: 'Customer web BFF. Stack: TS Lambda.' },
  { repo: 'policy-svc', indexedAt: 't', body: 'Policy microservice. Stack: Java.' },
];
const requirement: HiveRequirement = {
  id: 'REQ-1', title: 'Add a claims endpoint', status: 'decomposing',
  decomposedInto: [], createdAt: 't', updatedAt: 't',
  body: 'Expose POST /v1/claims and persist the claim.',
};

describe('buildDecomposeSystemPrompt', () => {
  it('instructs read-only JSON-only output', () => {
    const sys = buildDecomposeSystemPrompt();
    expect(sys).toMatch(/read-only|do not (edit|write|modify)/i);
    expect(sys).toMatch(/json/i);
  });
});

describe('buildDecomposePrompt', () => {
  it('embeds the requirement + every profile + the ManagerPlan contract', () => {
    const p = buildDecomposePrompt(requirement, profiles);
    expect(p).toContain('Add a claims endpoint');
    expect(p).toContain('Expose POST /v1/claims');
    expect(p).toContain('bff-web');
    expect(p).toContain('policy-svc');
    expect(p).toContain('Customer web BFF');
    expect(p).toContain('"stories"');
    expect(p).toContain('acceptanceCriteria');
  });
});

describe('parsePlan', () => {
  const validBlock = '```json\n' + JSON.stringify({
    stories: [
      { title: 'Add handler', body: 'Create the Lambda.', team: 'bff-web', role: 'senior', acceptanceCriteria: ['returns 201'] },
    ],
  }) + '\n```';

  it('extracts a fenced json block', () => {
    const plan = parsePlan('Here is the plan:\n' + validBlock + '\nDone.');
    expect(plan.stories).toHaveLength(1);
    expect(plan.stories[0].team).toBe('bff-web');
  });

  it('takes the LAST fenced json block when several appear', () => {
    const first = '```json\n' + JSON.stringify({ stories: [{ title: 'A', body: 'a', team: 'x', role: 'junior', acceptanceCriteria: [] }] }) + '\n```';
    const plan = parsePlan(first + '\n' + validBlock);
    expect(plan.stories[0].title).toBe('Add handler');
  });

  it('accepts a bare top-level JSON object with no fence', () => {
    const plan = parsePlan(JSON.stringify({ stories: [{ title: 'T', body: 'b', team: 'bff-web', role: 'senior', acceptanceCriteria: ['x'] }] }));
    expect(plan.stories).toHaveLength(1);
  });

  it('coerces an unknown role to senior', () => {
    const plan = parsePlan('```json\n' + JSON.stringify({ stories: [{ title: 'T', body: 'b', team: 'bff-web', role: 'wizard', acceptanceCriteria: ['x'] }] }) + '\n```');
    expect(plan.stories[0].role).toBe('senior');
  });

  it('defaults a missing acceptanceCriteria to []', () => {
    const plan = parsePlan('```json\n' + JSON.stringify({ stories: [{ title: 'T', body: 'b', team: 'bff-web', role: 'senior' }] }) + '\n```');
    expect(plan.stories[0].acceptanceCriteria).toEqual([]);
  });

  it('throws PlanParseError when there is no JSON', () => {
    expect(() => parsePlan('no json here')).toThrow(PlanParseError);
  });

  it('throws PlanParseError on empty stories', () => {
    expect(() => parsePlan('```json\n{"stories":[]}\n```')).toThrow(PlanParseError);
  });

  it('throws PlanParseError when a story is missing a required string field', () => {
    expect(() => parsePlan('```json\n' + JSON.stringify({ stories: [{ title: 'T', team: 'bff-web', role: 'senior', acceptanceCriteria: [] }] }) + '\n```')).toThrow(PlanParseError);
  });

  it('throws PlanParseError on malformed JSON in the fence', () => {
    expect(() => parsePlan('```json\n{ not json\n```')).toThrow(PlanParseError);
  });
});

describe('writeProposedStories', () => {
  let ws: string;
  const repos: Repo[] = [
    { name: 'bff-web', path: '/r/bff-web', isGitRepo: true },
    { name: 'policy-svc', path: '/r/policy-svc', isGitRepo: true },
  ];
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'hive-dec-'));
    await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
    await mkdir(join(ws, '.hive', 'state', 'requirements'), { recursive: true });
    await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
    await writeFile(
      join(ws, '.hive/state/requirements/REQ-1.md'),
      serializeRequirement(requirement),
      'utf8',
    );
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it('writes proposed stories, sets the requirement decomposed + decomposed event', async () => {
    const plan: ManagerPlan = {
      stories: [
        { title: 'Add handler', body: 'Create the Lambda.', team: 'bff-web', role: 'senior', acceptanceCriteria: ['returns 201'] },
        { title: 'Persist claim', body: 'Store it.', team: 'policy-svc', role: 'intermediate', acceptanceCriteria: ['row inserted'] },
      ],
    };
    const res = await writeProposedStories(ws, 'REQ-1', plan, repos, 't1');
    expect(res.storyIds).toHaveLength(2);
    expect(res.unknownTeamIds).toEqual([]);

    const s0 = parseStory(await readFile(join(ws, '.hive/state/stories', `${res.storyIds[0]}.md`), 'utf8'), res.storyIds[0]);
    expect(s0.status).toBe('proposed');
    expect(s0.parentRequirement).toBe('REQ-1');
    expect(s0.team).toBe('bff-web');
    expect(s0.role).toBe('senior');

    const r = parseRequirement(await readFile(join(ws, '.hive/state/requirements/REQ-1.md'), 'utf8'), 'REQ-1');
    expect(r.status).toBe('decomposed');
    expect(r.decomposedInto).toEqual(res.storyIds);

    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"decomposed"');
    expect(events).toContain('"detail":"REQ-1"');
  });

  it('still writes a story routed to an unknown team and flags it', async () => {
    const plan: ManagerPlan = {
      stories: [
        { title: 'Mystery', body: 'x', team: 'nope', role: 'senior', acceptanceCriteria: [] },
      ],
    };
    const res = await writeProposedStories(ws, 'REQ-1', plan, repos, 't1');
    expect(res.storyIds).toHaveLength(1);
    expect(res.unknownTeamIds).toEqual(res.storyIds);
    const s = parseStory(await readFile(join(ws, '.hive/state/stories', `${res.storyIds[0]}.md`), 'utf8'), res.storyIds[0]);
    expect(s.team).toBe('nope'); // kept as-is; renderer badges it
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/main/hive/manager/decompose.test.ts` — module not found.

- [ ] **Step 3: Implement `decompose.ts`.** Create `src/main/hive/manager/decompose.ts`:

```ts
/**
 * Requirement decomposition (slice 2b-2b). Pure prompt builders for the
 * read-only manager run, a defensive parser/validator for its JSON plan, and a
 * writer that fans a validated plan into `proposed` story files. The agent only
 * reads; hive owns every write (validated here).
 */

import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  HIVE_ROLES,
  type HiveRequirement,
  type HiveRole,
  type HiveStory,
  type ManagerPlan,
  type ProposedStory,
  type RepoProfile,
} from '../../../types/hive';
import type { Repo } from '../../../types/workspace';
import { parseRequirement } from '../parse';
import { serializeStory, eventLine } from '../run/serialize';
import { slugify, uniqueStoryId } from '../run/story';
import { serializeRequirement } from './requirement';

/** Thrown when the manager's output is missing/malformed/empty. Caller → blocked. */
export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanParseError';
  }
}

const DEFAULT_ROLE: HiveRole = 'senior';

/** System prompt: a read-only analyst that emits ONLY a fenced JSON plan. */
export function buildDecomposeSystemPrompt(): string {
  return [
    'You are a read-only engineering manager decomposing a requirement into',
    'stories. You MUST NOT edit, write, or modify any file, run commands, or',
    'commit. You only read what you are given and reason.',
    '',
    'Your ENTIRE response must be a single fenced ```json code block — and',
    'nothing else — matching this shape:',
    '{ "stories": [ { "title": string, "body": string, "team": string,',
    '  "role": "manager"|"tech-lead"|"senior"|"intermediate"|"junior"|"qa",',
    '  "acceptanceCriteria": string[] } ] }',
    '',
    'Rules:',
    '- Each story targets exactly ONE repo via its `team` (a repo name from the',
    '  provided profiles).',
    '- Set a sensible `role` and concrete `acceptanceCriteria` per story.',
    '- Emit the stories in execution order (earliest first).',
    '- Do not include prose outside the JSON block.',
  ].join('\n');
}

/** Task prompt: the requirement + every cached repo profile + the contract. */
export function buildDecomposePrompt(
  requirement: HiveRequirement,
  profiles: RepoProfile[],
): string {
  const profileBlocks =
    profiles.length > 0
      ? profiles
          .map((p) => [`### ${p.repo}`, p.body.trim() || '(no profile body)'].join('\n'))
          .join('\n\n')
      : '(no repo profiles available)';
  return [
    `# Requirement ${requirement.id}: ${requirement.title}`,
    '',
    '## Description',
    requirement.body.trim() || '(no description)',
    '',
    '## Available repos (cached profiles)',
    'Route each story to exactly one of these repos by its `team` name:',
    '',
    profileBlocks,
    '',
    '## Output',
    'Respond with ONLY a single fenced ```json block matching:',
    '```json',
    '{ "stories": [ { "title": "...", "body": "...", "team": "<repo>",',
    '  "role": "senior", "acceptanceCriteria": ["..."] } ] }',
    '```',
    'Order the stories by execution order. No prose outside the block.',
  ].join('\n');
}

/** Extract the LAST fenced ```json block, else a bare top-level JSON object. */
function extractJson(text: string): string | null {
  const fence = /```json\s*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fence.exec(text)) !== null) {
    last = match[1].trim();
  }
  if (last !== null) return last;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return null;
}

function coerceRole(v: unknown): HiveRole {
  return typeof v === 'string' && (HIVE_ROLES as readonly string[]).includes(v)
    ? (v as HiveRole)
    : DEFAULT_ROLE;
}

function reqString(v: unknown, field: string, idx: number): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new PlanParseError(`story[${idx}].${field} must be a non-empty string`);
  }
  return v;
}

/**
 * Parse + validate the manager's result text into a ManagerPlan. Throws
 * PlanParseError on anything the caller should treat as a blocked decompose.
 */
export function parsePlan(resultText: string): ManagerPlan {
  const json = extractJson(resultText);
  if (json === null) throw new PlanParseError('no JSON block in manager output');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new PlanParseError(`manager output is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new PlanParseError('manager output is not an object');
  }
  const rawStories = (parsed as { stories?: unknown }).stories;
  if (!Array.isArray(rawStories) || rawStories.length === 0) {
    throw new PlanParseError('manager output has no stories');
  }
  const stories: ProposedStory[] = rawStories.map((raw, idx): ProposedStory => {
    if (!raw || typeof raw !== 'object') {
      throw new PlanParseError(`story[${idx}] is not an object`);
    }
    const s = raw as Record<string, unknown>;
    return {
      title: reqString(s.title, 'title', idx),
      body: reqString(s.body, 'body', idx),
      team: reqString(s.team, 'team', idx),
      role: coerceRole(s.role),
      acceptanceCriteria: Array.isArray(s.acceptanceCriteria)
        ? s.acceptanceCriteria.map((x) => String(x))
        : [],
    };
  });
  return { stories };
}

async function existingStoryIds(workspacePath: string): Promise<Set<string>> {
  try {
    const names = await readdir(join(workspacePath, '.hive', 'state', 'stories'));
    return new Set(names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
  } catch {
    return new Set();
  }
}

/** Build a `proposed` HiveStory from a ProposedStory + a resolved id + ts. */
function buildProposedStory(
  p: ProposedStory,
  id: string,
  reqId: string,
  now: string,
): HiveStory {
  return {
    id,
    title: p.title.trim(),
    status: 'proposed',
    role: p.role,
    points: 0,
    team: p.team,
    dependsOn: [],
    acceptanceCriteria: p.acceptanceCriteria,
    parentRequirement: reqId,
    createdAt: now,
    updatedAt: now,
    body: p.body,
  };
}

export interface WriteProposedResult {
  /** Ids of the written proposed stories, in plan order. */
  storyIds: string[];
  /** Subset of storyIds whose `team` is not a repo name (soft-flagged). */
  unknownTeamIds: string[];
}

/**
 * Fan a validated plan into `proposed` story files, set the requirement to
 * `decomposed` with decomposedInto filled, append a `decomposed` event. Routing
 * is soft: an unknown team is kept (renderer badges it; resolveRepoForStory
 * falls back at run time). Returns the new ids + which had unknown teams.
 */
export async function writeProposedStories(
  workspacePath: string,
  reqId: string,
  plan: ManagerPlan,
  repos: readonly Repo[],
  now: string,
): Promise<WriteProposedResult> {
  const repoNames = new Set(repos.map((r) => r.name));
  const taken = await existingStoryIds(workspacePath);
  const storyIds: string[] = [];
  const unknownTeamIds: string[] = [];

  for (const p of plan.stories) {
    const id = uniqueStoryId(slugify(p.title), taken);
    taken.add(id);
    const story = buildProposedStory(p, id, reqId, now);
    await writeFile(
      join(workspacePath, '.hive', 'state', 'stories', `${id}.md`),
      serializeStory(story),
      'utf8',
    );
    storyIds.push(id);
    if (!repoNames.has(p.team)) unknownTeamIds.push(id);
  }

  const reqPath = join(workspacePath, '.hive', 'state', 'requirements', `${reqId}.md`);
  const current = parseRequirement(await readFile(reqPath, 'utf8'), reqId);
  await writeFile(
    reqPath,
    serializeRequirement({
      ...current,
      status: 'decomposed',
      decomposedInto: storyIds,
      updatedAt: now,
    }),
    'utf8',
  );
  await appendFile(
    join(workspacePath, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'manager', event: 'decomposed', detail: reqId, level: 'ok' }) + '\n',
    'utf8',
  );

  return { storyIds, unknownTeamIds };
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/main/hive/manager/decompose.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/manager/decompose.ts src/main/hive/manager/decompose.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): decompose prompts + parsePlan + writeProposedStories

Read-only manager prompts; defensive plan parse/validate (last fenced
json, coerce role, reject empty/malformed → PlanParseError); fan the plan
into proposed stories with soft routing validation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `approve.ts` — approve + discard

`approvePlan`: load the requirement's `proposed` stories (those with `parentRequirement === reqId`), flip each → `pending`, set the requirement → `in-flight`, append an `approved` event. `discardPlan`: delete those proposed story files + the requirement file, append an `abandoned` event (a rejected plan leaves nothing for the loop).

**Files:**
- Create: `src/main/hive/manager/approve.ts`
- Test: `src/main/hive/manager/approve.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/main/hive/manager/approve.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { approvePlan, discardPlan } from './approve';
import { serializeStory } from '../run/serialize';
import { serializeRequirement } from './requirement';
import { parseStory, parseRequirement } from '../parse';
import type { HiveRequirement, HiveStory } from '../../../types/hive';

let ws: string;

function story(over: Partial<HiveStory>): HiveStory {
  return {
    id: 'x', title: 'x', status: 'proposed', role: 'senior', points: 0,
    team: 'web', dependsOn: [], acceptanceCriteria: ['a'], parentRequirement: 'REQ-1',
    createdAt: 't', updatedAt: 't', body: 'b', ...over,
  };
}
const requirement: HiveRequirement = {
  id: 'REQ-1', title: 'Req', status: 'decomposed',
  decomposedInto: ['s-a', 's-b'], createdAt: 't', updatedAt: 't', body: 'desc',
};

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'hive-appr-'));
  await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
  await mkdir(join(ws, '.hive', 'state', 'requirements'), { recursive: true });
  await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
  await writeFile(join(ws, '.hive/state/requirements/REQ-1.md'), serializeRequirement(requirement));
  await writeFile(join(ws, '.hive/state/stories/s-a.md'), serializeStory(story({ id: 's-a' })));
  await writeFile(join(ws, '.hive/state/stories/s-b.md'), serializeStory(story({ id: 's-b' })));
  // An unrelated story must be left untouched.
  await writeFile(join(ws, '.hive/state/stories/other.md'), serializeStory(story({ id: 'other', parentRequirement: 'REQ-9' })));
});
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe('approvePlan', () => {
  it('flips the requirement proposed stories to pending, requirement to in-flight, logs approved', async () => {
    await approvePlan(ws, 'REQ-1', 't2');
    const a = parseStory(await readFile(join(ws, '.hive/state/stories/s-a.md'), 'utf8'), 's-a');
    const b = parseStory(await readFile(join(ws, '.hive/state/stories/s-b.md'), 'utf8'), 's-b');
    expect(a.status).toBe('pending');
    expect(b.status).toBe('pending');
    const r = parseRequirement(await readFile(join(ws, '.hive/state/requirements/REQ-1.md'), 'utf8'), 'REQ-1');
    expect(r.status).toBe('in-flight');
    const other = parseStory(await readFile(join(ws, '.hive/state/stories/other.md'), 'utf8'), 'other');
    expect(other.status).toBe('proposed'); // untouched
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"approved"');
  });
});

describe('discardPlan', () => {
  it('deletes the proposed stories + the requirement, logs abandoned, leaves others', async () => {
    await discardPlan(ws, 'REQ-1', 't2');
    await expect(access(join(ws, '.hive/state/stories/s-a.md'))).rejects.toThrow();
    await expect(access(join(ws, '.hive/state/stories/s-b.md'))).rejects.toThrow();
    await expect(access(join(ws, '.hive/state/requirements/REQ-1.md'))).rejects.toThrow();
    await access(join(ws, '.hive/state/stories/other.md')); // survives
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"abandoned"');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/main/hive/manager/approve.test.ts` — module not found.

- [ ] **Step 3: Implement `approve.ts`.** Create `src/main/hive/manager/approve.ts`:

```ts
/**
 * Requirement approval gate (slice 2b-2b). approvePlan flips the requirement's
 * `proposed` stories to `pending` (the 2b-1 loop then runs them) and the
 * requirement to `in-flight`. discardPlan deletes the proposed stories + the
 * requirement file so a rejected plan leaves no trace for the loop.
 */

import { appendFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HiveStory } from '../../../types/hive';
import { parseStory, parseRequirement } from '../parse';
import { serializeStory, eventLine } from '../run/serialize';
import { serializeRequirement } from './requirement';

function storiesDir(ws: string): string {
  return join(ws, '.hive', 'state', 'stories');
}
function reqPath(ws: string, reqId: string): string {
  return join(ws, '.hive', 'state', 'requirements', `${reqId}.md`);
}

/** The `proposed` stories under a requirement (parentRequirement === reqId). */
async function proposedStoriesFor(ws: string, reqId: string): Promise<HiveStory[]> {
  let names: string[];
  try {
    names = await readdir(storiesDir(ws));
  } catch {
    return [];
  }
  const out: HiveStory[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    try {
      const s = parseStory(await readFile(join(storiesDir(ws), name), 'utf8'), id);
      if (s.status === 'proposed' && s.parentRequirement === reqId) out.push(s);
    } catch {
      // skip unparseable
    }
  }
  return out;
}

/** Approve: proposed stories → pending, requirement → in-flight, log approved. */
export async function approvePlan(ws: string, reqId: string, now: string): Promise<void> {
  const stories = await proposedStoriesFor(ws, reqId);
  for (const s of stories) {
    await writeFile(
      join(storiesDir(ws), `${s.id}.md`),
      serializeStory({ ...s, status: 'pending', updatedAt: now }),
      'utf8',
    );
  }
  try {
    const current = parseRequirement(await readFile(reqPath(ws, reqId), 'utf8'), reqId);
    await writeFile(
      reqPath(ws, reqId),
      serializeRequirement({ ...current, status: 'in-flight', updatedAt: now }),
      'utf8',
    );
  } catch {
    // requirement file missing — still log the approval for the stories
  }
  await appendFile(
    join(ws, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'user', event: 'approved', detail: reqId, level: 'ok' }) + '\n',
    'utf8',
  );
}

/** Discard: delete the requirement's proposed stories + the requirement, log abandoned. */
export async function discardPlan(ws: string, reqId: string, now: string): Promise<void> {
  const stories = await proposedStoriesFor(ws, reqId);
  for (const s of stories) {
    await rm(join(storiesDir(ws), `${s.id}.md`), { force: true });
  }
  await rm(reqPath(ws, reqId), { force: true });
  await appendFile(
    join(ws, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'user', event: 'abandoned', detail: reqId, level: 'warn' }) + '\n',
    'utf8',
  );
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/main/hive/manager/approve.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/manager/approve.ts src/main/hive/manager/approve.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): approvePlan + discardPlan (manager approval gate)

Approve flips a requirement's proposed stories to pending + requirement
to in-flight; discard deletes them + the requirement, logging approved /
abandoned.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `buildDecomposeJob` — the decompose `ManagerJob` factory

The manager lane from 2b-2a is **generic** and is NOT edited by 2b-2b: a job is fully described by its callbacks (`buildSpec` / `onResult` / `onFailure`) and the lane never switches on a `kind`. This task adds an exported factory `buildDecomposeJob(deps): ManagerJob` (in `decompose.ts`) that closes over everything a decompose run needs and returns the generic job the lane consumes.

**Key responsibility split (read carefully):**
- The lane calls `onFailure(detail)` ONLY for process-level failures (non-zero exit / spawn error / empty result). A throw *inside* `onResult` is NOT routed to `onFailure` — so `onResult` MUST catch its own parse/validation errors and perform the blocked transition itself.
- Therefore: `onResult` wraps `parsePlan` + `writeProposedStories` in a try/catch; a thrown `PlanParseError` (or any error) → `markBlocked(reqId, detail)` (requirement → `blocked` + `failed` event). `onFailure` → the same `markBlocked` path for process-level failures.
- The requirement → `decomposing` write happens in the **wiring** (Task 8) at enqueue time, not in the job — the lane and the job stay free of that side effect. The factory just emits the run + writes the plan on success / blocks on failure.

**Files:**
- Modify: `src/main/hive/manager/decompose.ts` (add `buildDecomposeJob`)
- Test: `src/main/hive/manager/decompose.test.ts` (add factory tests — direct + lane integration)

- [ ] **Step 1: Write the failing tests.** Add to `src/main/hive/manager/decompose.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { createManagerLane } from './lane';
import { buildDecomposeJob } from './decompose';
import type { Runner } from '../run/runner';

const job_profiles: RepoProfile[] = [{ repo: 'bff-web', indexedAt: 't', body: 'web bff' }];
const job_repos: Repo[] = [{ name: 'bff-web', path: '/r/bff-web', isGitRepo: true }];
const job_req: HiveRequirement = {
  id: 'REQ-1', title: 'R', status: 'decomposing', decomposedInto: [],
  createdAt: 't', updatedAt: 't', body: 'desc',
};

const VALID = '```json\n' + JSON.stringify({
  stories: [{ title: 'T', body: 'b', team: 'bff-web', role: 'senior', acceptanceCriteria: ['x'] }],
}) + '\n```';

function makeJobDeps() {
  const calls = { wrote: [] as string[], blocked: [] as Array<{ reqId: string; detail: string }> };
  const deps = {
    workspacePath: '/ws',
    requirement: job_req,
    profiles: job_profiles,
    repos: job_repos,
    writeProposedStories: vi.fn(async (reqId: string) => { calls.wrote.push(reqId); return { storyIds: ['s1'], unknownTeamIds: [] }; }),
    markBlocked: vi.fn(async (reqId: string, detail: string) => { calls.blocked.push({ reqId, detail }); }),
  };
  return { deps, calls };
}

describe('buildDecomposeJob (direct)', () => {
  it('returns a decomposing job whose buildSpec carries the prompts + workspace cwd', () => {
    const { deps } = makeJobDeps();
    const job = buildDecomposeJob(deps);
    expect(job.activity).toBe('decomposing');
    expect(job.target).toBe('REQ-1');
    const spec = job.buildSpec('run_x');
    expect(spec.cwd).toBe('/ws');
    expect(spec.runId).toBe('run_x');
    expect(spec.taskPrompt).toContain('REQ-1');
    expect(spec.systemPrompt).toMatch(/json/i);
  });

  it('onResult parses the plan and writes proposed stories', async () => {
    const { deps, calls } = makeJobDeps();
    await buildDecomposeJob(deps).onResult(VALID);
    expect(calls.wrote).toContain('REQ-1');
    expect(calls.blocked).toEqual([]);
  });

  it('onResult blocks the requirement when the plan is unparseable (catches its own throw)', async () => {
    const { deps, calls } = makeJobDeps();
    await buildDecomposeJob(deps).onResult('no json here');
    expect(calls.wrote).toEqual([]);
    expect(calls.blocked.map((b) => b.reqId)).toContain('REQ-1');
  });

  it('onFailure blocks the requirement (process-level failure)', async () => {
    const { deps, calls } = makeJobDeps();
    await buildDecomposeJob(deps).onFailure('exited with code 2');
    expect(calls.blocked.map((b) => b.reqId)).toContain('REQ-1');
  });
});

describe('buildDecomposeJob (lane integration)', () => {
  function fakeRunner(child: EventEmitter & { stdout: EventEmitter }) {
    const runner: Runner = {
      isBusy: () => false,
      start: (_spec, ev) => {
        // Emit a result line then exit, mirroring the real runner's onResult.
        queueMicrotask(() => {
          ev.onResult?.(VALID);
          ev.onExit({ code: 0, signal: null });
        });
      },
      stop: async () => {},
    };
    void child;
    return runner;
  }

  it('runs the built job through a real lane + injected runner and writes the plan', async () => {
    const { deps, calls } = makeJobDeps();
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
    child.stdout = new EventEmitter();
    const statuses: string[] = [];
    const lane = createManagerLane({
      createRunner: () => fakeRunner(child),
      onStatus: (e) => statuses.push(`${e.activity}:${e.status}:${e.outcome ?? ''}`),
      now: () => 't',
      newRunId: () => 'run_1',
    });
    lane.enqueue(buildDecomposeJob(deps));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.wrote).toContain('REQ-1');
    expect(statuses.some((s) => s.startsWith('decomposing:'))).toBe(true);
  });
});
```

  > The lane-integration test relies on the 2b-2a `createManagerLane` signature (`createRunner` injected, `onStatus`/`now`/`newRunId`). If the 2b-2a lane.test exposes a shared fake-runner helper, reuse it instead of the inline `fakeRunner` above.

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/main/hive/manager/decompose.test.ts` — `buildDecomposeJob` does not exist.

- [ ] **Step 3: Implement `buildDecomposeJob` in `decompose.ts`.** This file already imports `HiveRequirement`, `RepoProfile`, `ManagerPlan` (merge them into the existing `from '../../../types/hive'` block if not already present) and already declares `WriteProposedResult` + `Repo`. Add ONE new import for the generic job type:

```ts
import type { ManagerJob } from './lane';
```

  > `ManagerJob` is the generic interface from the 2b-2a lane (`activity`/`target`/`buildSpec`/`onResult`/`onFailure`). Importing only the type creates no runtime cycle. `WriteProposedResult` is defined earlier in this same file — reference it directly (no self-import).

  Append the factory at the end of `decompose.ts`:

```ts
/** Closures a decompose job needs. The lane stays generic; this binds the work. */
export interface DecomposeJobDeps {
  workspacePath: string;
  requirement: HiveRequirement;
  profiles: RepoProfile[];
  repos: readonly Repo[];
  /** Write the plan's proposed stories + flip the requirement → decomposed. */
  writeProposedStories: (
    reqId: string,
    plan: ManagerPlan,
    repos: readonly Repo[],
  ) => Promise<WriteProposedResult>;
  /** Mark the requirement blocked + append a `failed` event. */
  markBlocked: (reqId: string, detail: string) => Promise<void>;
}

/**
 * Build the generic `ManagerJob` the manager lane runs for a requirement
 * decompose. `buildSpec` renders the read-only claude run; `onResult` parses +
 * writes the plan (catching its OWN parse/validation errors → blocked, because
 * the lane does not route a throw inside onResult to onFailure); `onFailure`
 * handles process-level failures (non-zero exit / spawn error / empty result).
 */
export function buildDecomposeJob(deps: DecomposeJobDeps): ManagerJob {
  const reqId = deps.requirement.id;
  return {
    activity: 'decomposing',
    target: reqId,
    buildSpec: (runId) => ({
      runId,
      storyId: reqId,
      role: 'manager',
      cwd: deps.workspacePath,
      taskPrompt: buildDecomposePrompt(deps.requirement, deps.profiles),
      systemPrompt: buildDecomposeSystemPrompt(),
    }),
    onResult: async (text) => {
      try {
        const plan = parsePlan(text);
        await deps.writeProposedStories(reqId, plan, deps.repos);
      } catch (e) {
        await deps.markBlocked(reqId, (e as Error).message);
      }
    },
    onFailure: async (detail) => {
      await deps.markBlocked(reqId, detail);
    },
  };
}
```

  > `buildDecomposePrompt`, `buildDecomposeSystemPrompt`, `parsePlan`, `ManagerPlan`, `Repo`, and `WriteProposedResult` are all already in scope in this module. The `RunSpec` shape returned by `buildSpec` matches `src/main/hive/run/runner.ts` (no extra fields).

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/main/hive/manager/decompose.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/manager/decompose.ts src/main/hive/manager/decompose.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): buildDecomposeJob factory (generic ManagerJob)

Returns the generic decompose ManagerJob the 2b-2a lane consumes:
buildSpec renders the read-only run, onResult parses + writes the plan
(catching its own parse errors → blocked, since the lane does not route an
onResult throw to onFailure), onFailure handles process-level failures.
lane.ts is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manager handlers — create / approve / discard channels

Add three channels to the existing `HIVE_MANAGER_CHANNELS` and extend `registerHiveManagerHandlers` deps. Mirror the existing handler/teardown style (see `run/handlers.ts` `registerHiveLoopHandlers`).

**Files:**
- Modify: `src/main/hive/manager/handlers.ts`
- Test: `src/main/hive/manager/handlers.test.ts` (extend the 2b-2a file)

- [ ] **Step 1: Write the failing test.** Add to `src/main/hive/manager/handlers.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ipcMain } from 'electron';

import { HIVE_MANAGER_CHANNELS, registerHiveManagerHandlers } from './handlers';

vi.mock('electron', () => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: (c: string, fn: (...a: unknown[]) => unknown) => handlers.set(c, fn),
      removeHandler: (c: string) => handlers.delete(c),
      __invoke: (c: string, ...a: unknown[]) => handlers.get(c)?.({}, ...a),
      __has: (c: string) => handlers.has(c),
    },
  };
});

const mm = ipcMain as unknown as {
  __invoke: (c: string, ...a: unknown[]) => unknown;
  __has: (c: string) => boolean;
};

afterEach(() => vi.restoreAllMocks());

describe('manager handlers — requirement channels', () => {
  it('routes create/approve/discard to deps and tears down', async () => {
    const createRequirement = vi.fn(async () => 'REQ-1');
    const approve = vi.fn(async () => {});
    const discard = vi.fn(async () => {});
    const teardown = registerHiveManagerHandlers({
      createRequirement, approve, discard,
      // ...the 2b-2a deps (reindex/indexStatus) are also required here; pass stubs.
    } as never);

    expect(await mm.__invoke(HIVE_MANAGER_CHANNELS.createRequirement, { title: 'X', body: 'y' })).toBe('REQ-1');
    expect(createRequirement).toHaveBeenCalledWith({ title: 'X', body: 'y' });

    await mm.__invoke(HIVE_MANAGER_CHANNELS.approve, { reqId: 'REQ-1' });
    expect(approve).toHaveBeenCalledWith('REQ-1');

    await mm.__invoke(HIVE_MANAGER_CHANNELS.discard, { reqId: 'REQ-1' });
    expect(discard).toHaveBeenCalledWith('REQ-1');

    teardown();
    expect(mm.__has(HIVE_MANAGER_CHANNELS.createRequirement)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/main/hive/manager/handlers.test.ts` — new channels/deps don't exist.

- [ ] **Step 3: Extend `handlers.ts`.** Add to `HIVE_MANAGER_CHANNELS`:

```ts
  createRequirement: 'ipc:hive:requirement:create',
  approve: 'ipc:hive:requirement:approve',
  discard: 'ipc:hive:requirement:discard',
```

  Add to the `registerHiveManagerHandlers` deps interface:

```ts
  /** Write the requirement file then enqueue a decompose job. Returns the id. */
  createRequirement: (fields: NewRequirementFields) => Promise<string>;
  approve: (reqId: string) => Promise<void>;
  discard: (reqId: string) => Promise<void>;
```

  (import `NewRequirementFields` from `../../../types/hive`.) Register the handlers in `registerHiveManagerHandlers`, mirroring the loop handlers:

```ts
  ipcMain.handle(HIVE_MANAGER_CHANNELS.createRequirement, (_e, fields: NewRequirementFields) =>
    deps.createRequirement(fields),
  );
  ipcMain.handle(HIVE_MANAGER_CHANNELS.approve, (_e, args: { reqId: string }) =>
    deps.approve(args.reqId),
  );
  ipcMain.handle(HIVE_MANAGER_CHANNELS.discard, (_e, args: { reqId: string }) =>
    deps.discard(args.reqId),
  );
```

  Ensure the teardown removes all channels (if 2b-2a uses `for (const c of Object.values(HIVE_MANAGER_CHANNELS)) ipcMain.removeHandler(c)` plus event teardown, the new channels are covered automatically; otherwise add explicit `removeHandler` calls for the three new channels).

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/main/hive/manager/handlers.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/manager/handlers.ts src/main/hive/manager/handlers.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): add requirement create/approve/discard manager channels

Mirrors the loop handlers; create writes the requirement then enqueues a
decompose job (wired in index.ts).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Main-process wiring (`index.ts`)

Wire `createRequirement` / `approve` / `discard`, mirroring how 2b-2a wired the manager lane + handlers and how 2b-1/2c wired `answerQuestion`/`createStory`/`ensureWorkspace`. The lane from 2b-2a is **generic** — it takes NO `readProfiles`/`getRepos`/`writeProposedStories`/`failRequirement` deps. Instead the wiring assembles a decompose `ManagerJob` via `buildDecomposeJob({...})` and enqueues it. `createRequirement` writes the requirement, flips it to `decomposing` (the wiring owns this side effect — the lane/job do not touch requirement files), then enqueues the built job. On app start, reset any stale `decomposing` requirement → `pending`.

> This task edits `src/main/index.ts` only. No new unit test (covered by the module tests + manual). Keep diffs minimal and mirror the existing `activeWorkspacePath` / `activeRepos` helpers and the manager-lane construction from 2b-2a.

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add imports.** Near the other hive imports in `src/main/index.ts`, add:

```ts
import {
  createRequirement as createRequirementFile,
  serializeRequirement,
} from './hive/manager/requirement';
import { writeProposedStories, buildDecomposeJob } from './hive/manager/decompose';
import { approvePlan, discardPlan } from './hive/manager/approve';
import { parseRequirement } from './hive/parse';
import { eventLine } from './hive/run/serialize';
```

  (If 2b-2a already imports `readProfiles`, `createManagerLane`, `registerHiveManagerHandlers`, the lane/handlers teardown handles, or `parseRequirement` — reuse those, do not duplicate.)

- [ ] **Step 2: Add the requirement helpers (NOT lane deps).** The 2b-2a `createManagerLane({ createRunner?, onStatus, now, newRunId })` call is unchanged — do NOT add deps to it. Instead define workspace-relative helpers near the existing `activeWorkspacePath` / `activeRepos` (these are closed over by the decompose job at enqueue time):

```ts
  const setRequirementStatusFn = async (
    reqId: string,
    status: import('../types/hive').RequirementStatus,
  ): Promise<void> => {
    const ws = activeWorkspacePath();
    if (!ws) return;
    const reqPath = join(ws, '.hive', 'state', 'requirements', `${reqId}.md`);
    try {
      const current = parseRequirement(await readFile(reqPath, 'utf8'), reqId);
      await writeFile(reqPath, serializeRequirement({ ...current, status, updatedAt: new Date().toISOString() }), 'utf8');
    } catch {
      // missing/unreadable — nothing to flip
    }
  };
  const markRequirementBlocked = async (reqId: string, detail: string): Promise<void> => {
    await setRequirementStatusFn(reqId, 'blocked');
    const ws = activeWorkspacePath();
    if (!ws) return;
    await appendFile(
      join(ws, '.hive', 'events.ndjson'),
      eventLine({ ts: new Date().toISOString(), actor: 'manager', event: 'failed', detail: `${reqId}: ${detail}`, level: 'warn' }) + '\n',
      'utf8',
    ).catch(() => undefined);
  };
```

  > `writeFile`/`readFile`/`appendFile` come from the existing `node:fs/promises` import; add `writeFile` to that import line if not already present. `readProfiles` is already imported by 2b-2a for the indexer — reuse it below.

- [ ] **Step 3: Wire the manager handlers' requirement deps.** In the `registerHiveManagerHandlers({ ... })` call (added by 2b-2a), add `createRequirement` / `approve` / `discard`. `createRequirement` writes the requirement, flips it to `decomposing`, builds the decompose job, and enqueues it:

```ts
    createRequirement: async (fields) => {
      const ws = activeWorkspacePath();
      if (!ws) throw new Error('No connected hive workspace');
      const now = new Date().toISOString();
      const reqId = await createRequirementFile(ws, fields, now);

      // The wiring owns the requirement → decomposing side effect (the lane +
      // job stay free of requirement-file writes).
      await setRequirementStatusFn(reqId, 'decomposing');

      const requirement = parseRequirement(
        await readFile(join(ws, '.hive', 'state', 'requirements', `${reqId}.md`), 'utf8'),
        reqId,
      );
      const repos = activeRepos();
      const profiles = await readProfiles(join(ws, '.hive', 'index'));

      // No repos at all → cannot route → block immediately, never enqueue.
      if (repos.length === 0 && profiles.length === 0) {
        await markRequirementBlocked(reqId, 'no repos to route to');
        return reqId;
      }

      hiveManagerLane.enqueue(
        buildDecomposeJob({
          workspacePath: ws,
          requirement,
          profiles,
          repos,
          writeProposedStories: (rid, plan, rs) =>
            writeProposedStories(ws, rid, plan, rs, new Date().toISOString()),
          markBlocked: markRequirementBlocked,
        }),
      );
      return reqId;
    },
    approve: async (reqId) => {
      const ws = activeWorkspacePath();
      if (!ws) return;
      await approvePlan(ws, reqId, new Date().toISOString());
    },
    discard: async (reqId) => {
      const ws = activeWorkspacePath();
      if (!ws) return;
      await discardPlan(ws, reqId, new Date().toISOString());
    },
```

  (`hiveManagerLane` is the lane instance from 2b-2a; reconcile to its actual variable name. `activeRepos` / `readProfiles` already exist from 2b-2a's index wiring.)

- [ ] **Step 4: Reset stale `decomposing` on start.** After the manager lane + reader are wired (and before `createWindow`), add a stale-state reset that mirrors any existing one. If 2b-2a added a stale `indexing` reset, extend the same block; otherwise add:

```ts
  // On app start a requirement left `decomposing` by a previous run's crash
  // must reset to `pending` so the operator can re-trigger decompose; it is
  // never wedged. Best-effort; failure is non-fatal.
  void (async () => {
    const ws = activeWorkspacePath();
    if (!ws) return;
    const dir = join(ws, '.hive', 'state', 'requirements');
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const n of names.filter((x) => x.endsWith('.md'))) {
      const id = n.slice(0, -3);
      try {
        const r = parseRequirement(await readFile(join(dir, n), 'utf8'), id);
        if (r.status === 'decomposing') {
          await writeFile(join(dir, n), serializeRequirement({ ...r, status: 'pending', updatedAt: new Date().toISOString() }), 'utf8');
        }
      } catch {
        // skip unparseable
      }
    }
  })();
```

  > Note `activeWorkspacePath()` may be null at `whenReady` (the workspace binds when a project opens). If 2b-2a runs its stale reset inside `setReaderWorkspace`/`ensureWorkspaceFor` instead, place this reset there too so it fires when a workspace actually connects. Keep it consistent with the existing pattern.

- [ ] **Step 5: Typecheck.** `rm -f *.tsbuildinfo && npm run typecheck` — clean. Then `npx vitest run` to confirm the main-side module tests still pass.

- [ ] **Step 6: Commit.**

```bash
git add src/main/index.ts
git commit -m "$(cat <<'EOF'
feat(hive): wire requirement create/approve/discard + decompose deps

createRequirement writes the file, flips it to decomposing, then enqueues
a generic decompose ManagerJob built via buildDecomposeJob (the lane stays
generic). approve/discard wired; stale decomposing resets to pending on
start.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Preload bridge — `window.hive.requirement`

Add the `requirement` bridge mirroring `story`/`loop`. Re-export `NewRequirementFields` from `api.ts`. Channel strings MUST match `handlers.ts` char-for-char.

**Files:**
- Modify: `src/preload/api.ts`, `src/preload/index.ts`

- [ ] **Step 1: Add the bridge interface + re-export in `api.ts`.** In `src/preload/api.ts`, in the hive types re-export block (near the `HiveConnection` re-export), add `NewRequirementFields`:

```ts
export type { NewRequirementFields } from '../types/hive';
```

  After the `HiveQuestionsBridge` interface, add:

```ts
/**
 * Hive requirement bridge (slice 2b-2b) — author a high-level requirement (→ a
 * decompose job on the manager lane) and approve/discard the proposed plan.
 * Flat request/response, mirroring the story/loop bridges.
 */
export interface HiveRequirementBridge {
  /** Write the requirement + enqueue decompose; resolves with the new id. */
  create(fields: import('../types/hive').NewRequirementFields): Promise<string>;
  /** Approve the proposed plan: stories → pending, requirement → in-flight. */
  approve(reqId: string): Promise<void>;
  /** Discard the proposed plan: delete proposed stories + the requirement. */
  discard(reqId: string): Promise<void>;
}
```

  Add `requirement` to `HiveBridge`:

```ts
  questions: HiveQuestionsBridge;
  requirement: HiveRequirementBridge;
```

- [ ] **Step 2: Implement the bridge in `index.ts`.** In `src/preload/index.ts`, add a channel constant block (place it after `HIVE_LOOP`):

```ts
const HIVE_REQUIREMENT = {
  create: 'ipc:hive:requirement:create',
  approve: 'ipc:hive:requirement:approve',
  discard: 'ipc:hive:requirement:discard',
} as const;
```

  Import `NewRequirementFields`:

```ts
import type {
  HiveConnection,
  HiveEvent,
  HiveLoopStatus,
  HiveQuestion,
  HiveRunLogEvent,
  HiveRunStatusEvent,
  HiveSnapshot,
  NewRequirementFields,
  NewStoryFields,
} from '../types/hive';
```

  Add the bridge to the `api` object (after `questions`):

```ts
  // Hive requirement bridge (slice 2b-2b) — author + approve/discard a plan.
  requirement: {
    create: (fields: NewRequirementFields) =>
      ipcRenderer.invoke(HIVE_REQUIREMENT.create, fields),
    approve: (reqId: string) =>
      ipcRenderer.invoke(HIVE_REQUIREMENT.approve, { reqId }),
    discard: (reqId: string) =>
      ipcRenderer.invoke(HIVE_REQUIREMENT.discard, { reqId }),
  },
```

  > VERIFY parity: `HIVE_REQUIREMENT.create === HIVE_MANAGER_CHANNELS.createRequirement === 'ipc:hive:requirement:create'`, `.approve === 'ipc:hive:requirement:approve'`, `.discard === 'ipc:hive:requirement:discard'`. The main handler reads `fields` directly for create (not `{ fields }`) and `{ reqId }` for approve/discard — matches the calls above.

- [ ] **Step 3: Typecheck.** `rm -f *.tsbuildinfo && npm run typecheck` — clean (the `HiveBridge` literal in `index.ts` now requires `requirement`, so a missing impl would error here).

- [ ] **Step 4: Commit.**

```bash
git add src/preload/api.ts src/preload/index.ts
git commit -m "$(cat <<'EOF'
feat(hive): expose window.hive.requirement (create/approve/discard)

Mirrors the story/loop bridges; channel strings match the manager handlers
char-for-char. Re-exports NewRequirementFields from the preload api.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Renderer — requirement-card adapter (`hiveView.ts`)

Add a pure adapter that groups `proposed` stories under their `parentRequirement` and exposes each requirement with its status + (for `decomposed`) its proposed stories tagged with their routed repo + an unknown-repo flag. No React, no IPC — unit-testable.

**Files:**
- Modify: `src/renderer/src/lib/hiveView.ts`
- Test: `src/renderer/src/lib/hiveView.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `src/renderer/src/lib/hiveView.test.ts`:

```ts
import { toRequirementCards } from './hiveView'
import type { HiveRequirement } from '../../../types/hive'

const req = (over: Partial<HiveRequirement>): HiveRequirement => ({
  id: 'REQ-1', title: 'Req', status: 'decomposed', decomposedInto: [],
  createdAt: '', updatedAt: '', body: '', ...over,
})

describe('toRequirementCards', () => {
  it('groups proposed stories under their parent requirement, tagging routed repos', () => {
    const cards = toRequirementCards(
      [req({ id: 'REQ-1', status: 'decomposed' })],
      [
        story({ id: 's1', status: 'proposed', parentRequirement: 'REQ-1', team: 'bff-web', role: 'senior' }),
        story({ id: 's2', status: 'proposed', parentRequirement: 'REQ-1', team: 'nope', role: 'junior' }),
        story({ id: 's3', status: 'pending', parentRequirement: 'REQ-1', team: 'bff-web' }),
      ],
      ['bff-web', 'policy-svc'],
    )
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe('REQ-1')
    expect(cards[0].status).toBe('decomposed')
    expect(cards[0].proposed.map((p) => p.id)).toEqual(['s1', 's2']) // pending excluded
    expect(cards[0].proposed[0]).toMatchObject({ team: 'bff-web', unknownRepo: false })
    expect(cards[0].proposed[1]).toMatchObject({ team: 'nope', unknownRepo: true })
  })

  it('shows a decomposing requirement with no proposed stories yet', () => {
    const cards = toRequirementCards([req({ id: 'R', status: 'decomposing' })], [], ['bff-web'])
    expect(cards[0].status).toBe('decomposing')
    expect(cards[0].proposed).toEqual([])
  })

  it('omits pending requirements (nothing to review yet)', () => {
    const cards = toRequirementCards([req({ id: 'R', status: 'pending' })], [], [])
    expect(cards).toEqual([])
  })
})
```

  (`story(...)` is the existing helper at the top of `hiveView.test.ts`; reuse it.)

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/renderer/src/lib/hiveView.test.ts` — `toRequirementCards` missing.

- [ ] **Step 3: Implement the adapter.** In `src/renderer/src/lib/hiveView.ts`, add `HiveRequirement` + `RequirementStatus` to the type import from `../../../types/hive`, then append:

```ts
export interface ProposedStoryCard {
  id: string
  title: string
  role: RoleKey
  /** Routed repo name (story.team). */
  team: string
  /** True when `team` is not one of the project's repo names. */
  unknownRepo: boolean
}

export interface RequirementCard {
  id: string
  title: string
  status: RequirementStatus
  /** Proposed stories grouped under this requirement (empty until decomposed). */
  proposed: ProposedStoryCard[]
}

/**
 * Group `proposed` stories under their parent requirement. Pending requirements
 * (not yet decomposed) are omitted — there is nothing to review. `repoNames` is
 * the active project's repo names, for the unknown-repo (⚠) flag.
 */
export function toRequirementCards(
  requirements: readonly HiveRequirement[],
  stories: readonly HiveStory[],
  repoNames: readonly string[],
): RequirementCard[] {
  const known = new Set(repoNames)
  const byReq = new Map<string, ProposedStoryCard[]>()
  for (const s of stories) {
    if (s.status !== 'proposed' || !s.parentRequirement) continue
    const card: ProposedStoryCard = {
      id: s.id,
      title: s.title,
      role: roleKey(s.role),
      team: s.team,
      unknownRepo: !known.has(s.team),
    }
    const list = byReq.get(s.parentRequirement)
    if (list) list.push(card)
    else byReq.set(s.parentRequirement, [card])
  }
  return requirements
    .filter((r) => r.status !== 'pending')
    .map((r): RequirementCard => ({
      id: r.id,
      title: r.title,
      status: r.status,
      proposed: byReq.get(r.id) ?? [],
    }))
}
```

  (`roleKey` already exists in this file. Add `HiveRequirement` + `RequirementStatus` to the existing `import type { … } from '../../../types/hive'`.)

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/renderer/src/lib/hiveView.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/src/lib/hiveView.ts src/renderer/src/lib/hiveView.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): toRequirementCards adapter (group proposed stories)

Groups proposed stories under their parent requirement, flags unknown
routed repos, omits not-yet-decomposed requirements. Pure + tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Renderer — NewRequirementModal + Requirement cards in the Dock

Create `NewRequirementModal` mirroring `NewStoryModal` (title + description only; submit → `window.hive.requirement.create({ title, body })`). Add a "+ New requirement" trigger near "+ New story". Render Requirement cards in `AgentDock` from `toRequirementCards`, with status pill, grouped proposed stories (role + routed repo + ⚠ badge), and Approve plan / Discard actions. Add CSS to `ide.css`.

> Renderer interaction tests aren't part of the existing suite for the Dock (it's a pure-ish renderer wired to `window.hive`); this task is verified by typecheck + the manual flow in the spec. Keep the modal/adapter logic in already-tested pure modules (Task 10) so the component stays thin.

**Files:**
- Create: `src/renderer/src/components/NewRequirementModal.tsx`
- Modify: `src/renderer/src/components/AgentDock.tsx`, `src/renderer/src/styles/ide.css`

- [ ] **Step 1: Create `NewRequirementModal.tsx`.** Create `src/renderer/src/components/NewRequirementModal.tsx`:

```tsx
import { useState } from 'react'

import type { NewRequirementFields } from '../../../types/hive'
import { Btn, Icon } from './primitives'

export interface NewRequirementModalProps {
  onClose: () => void
  onCreate: (fields: NewRequirementFields) => void
}

/**
 * Author a hive requirement from the UI (slice 2b-2b). Collects a title + a
 * high-level description; on submit hands `NewRequirementFields` to the caller
 * (which calls `window.hive.requirement.create`). The manager then decomposes
 * it into proposed stories the operator reviews. Reuses NewStoryModal's `ns-*`
 * CSS so the form matches the dark IDE theme.
 */
export function NewRequirementModal({ onClose, onCreate }: NewRequirementModalProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const canCreate = title.trim() !== ''

  const submit = (): void => {
    if (!canCreate) return
    onCreate({ title: title.trim(), body })
  }

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div
        className="cmd new-story-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-req-title"
      >
        <div className="ns-head">
          <h2 id="new-req-title" className="ns-title">New requirement</h2>
          <button type="button" className="ns-close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="ns-body">
          <label className="ns-field">
            <span className="ns-label">Title</span>
            <input
              className="ns-input"
              aria-label="Title"
              placeholder="Add OAuth login across the stack"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </label>

          <label className="ns-field">
            <span className="ns-label">Description</span>
            <textarea
              className="ns-input ns-textarea"
              aria-label="Description"
              placeholder="Describe the outcome you want. Hive decomposes it into routed stories."
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        </div>

        <div className="ns-foot">
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="cta" disabled={!canCreate} onClick={submit}>Create requirement</Btn>
        </div>
      </div>
    </div>
  )
}

export default NewRequirementModal
```

- [ ] **Step 2: Thread requirement data into the Dock.** In `src/renderer/src/components/AgentDock.tsx`:

  1. Add imports:

```tsx
import { NewRequirementModal } from './NewRequirementModal'
import type { RequirementCard } from '../lib/hiveView'
```

  2. Extend `DockProps` with the requirement cards (App will build them with `toRequirementCards`):

```tsx
export interface DockProps {
  onOpenFile: OpenFile
  board: Board
  needsInput: Story[]
  requirements: RequirementCard[]
  roster: Agent[]
  chat: ChatMsg[]
  hiveConnection: HiveConnection
  onConnectHive: () => void
}
```

  3. Destructure `requirements` in `Dock({ … })` and add modal state `const [showNewReq, setShowNewReq] = useState(false)`.

  4. In the `board` tab, alongside the existing "New story" button row, add a "New requirement" button and a `RequirementsSection` above the `MiniBoard`:

```tsx
        {tab === 'board' && (
          <>
            {hiveConnection.state === 'connected' && (
              <div style={{ padding: '8px 12px', display: 'flex', gap: 8 }}>
                <Btn kind="outline" sm icon="plus" onClick={() => setShowNewStory(true)}>
                  New story
                </Btn>
                <Btn kind="outline" sm icon="plus" onClick={() => setShowNewReq(true)}>
                  New requirement
                </Btn>
              </div>
            )}
            {hiveConnection.state === 'connected' && requirements.length > 0 && (
              <RequirementsSection requirements={requirements} />
            )}
            <MiniBoard board={board} onOpenFile={onOpenFile} run={runControl} />
          </>
        )}
```

  5. Render the modal next to the existing `NewStoryModal` block:

```tsx
      {showNewReq && project && hiveConnection.state === 'connected' && (
        <NewRequirementModal
          onClose={() => setShowNewReq(false)}
          onCreate={async (fields) => {
            setShowNewReq(false)
            try {
              await window.hive.requirement.create(fields)
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('create requirement failed', err)
            }
          }}
        />
      )}
```

  6. Add the `RequirementsSection` + `RequirementCardView` components (above the `Dock` export):

```tsx
function RequirementsSection({ requirements }: { requirements: RequirementCard[] }) {
  return (
    <div className="dock-sec req-sec">
      <h4>Requirements <span className="ct">{requirements.length}</span></h4>
      {requirements.map((r) => (
        <RequirementCardView key={r.id} req={r} />
      ))}
    </div>
  )
}

function RequirementCardView({ req }: { req: RequirementCard }) {
  const approve = (): void => { void window.hive.requirement.approve(req.id) }
  const discard = (): void => { void window.hive.requirement.discard(req.id) }
  return (
    <div className="req-card">
      <div className="req-head">
        <span className="req-id">{req.id}</span>
        <span className={`req-pill req-pill--${req.status}`}>
          {req.status === 'decomposing' && <Pulse />}
          {req.status}
        </span>
      </div>
      <div className="req-title">{req.title}</div>
      {req.status === 'decomposed' && (
        <>
          <div className="req-proposed">
            {req.proposed.map((p) => (
              <div key={p.id} className="req-pstory">
                <RoleAva role={p.role} size={18} />
                <span className="req-pstory-title">{p.title}</span>
                <span className={'req-repo' + (p.unknownRepo ? ' req-repo--warn' : '')}>
                  {p.unknownRepo && <Icon name="alert-triangle" size={12} />}
                  {p.team || '(unrouted)'}
                </span>
              </div>
            ))}
            {req.proposed.length === 0 && (
              <div className="req-empty">No stories proposed.</div>
            )}
          </div>
          <div className="req-actions">
            <Btn kind="cta" sm icon="check" onClick={approve}>Approve plan</Btn>
            <Btn kind="ghost" sm icon="x" onClick={discard}>Discard</Btn>
          </div>
        </>
      )}
    </div>
  )
}
```

  > `Pulse`, `RoleAva`, `Icon`, `Btn` are already imported. `RoleKey` carried in `ProposedStoryCard.role` matches `RoleAva`'s `role` prop. If `alert-triangle` is not a registered icon name, fall back to a literal `⚠` span (`<span className="req-warn-glyph">⚠</span>`) — check `primitives` for the icon registry before choosing.

- [ ] **Step 3: Pass `requirements` from `App.tsx`.** In `src/renderer/src/App.tsx`, where `liveBoard`/`liveNeedsInput` are derived (around line 225) add:

```tsx
  const liveRequirements = useMemo(
    () => toRequirementCards(
      hiveSnapshot.requirements,
      hiveSnapshot.stories,
      (project?.repos ?? []).map((r) => r.name),
    ),
    [hiveSnapshot.requirements, hiveSnapshot.stories, project],
  )
```

  Import `toRequirementCards` from `./lib/hiveView` (extend the existing import). Pass `requirements={liveRequirements}` into every `<Dock … />` render site (there is one primary site near line 758 / the Dock usage — search `board={liveBoard}` and add the prop alongside it). Ensure `project` is in scope (it is read elsewhere in App via the workspace store; if not in this scope, read it: `const project = useWorkspaceStore((s) => s.project)`).

- [ ] **Step 4: Add CSS.** In `src/renderer/src/styles/ide.css`, after the `.scard .sf` rule (the slice-2b-1 dock block, ~line 366), add:

```css
/* ---------- Hive requirement cards (slice 2b-2b) ---------- */
.req-sec { }
.req-card { background: var(--bg-elevated); border: 1px solid var(--border-default); border-radius: var(--r-md); padding: 10px 11px; margin-bottom: 8px; }
.req-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.req-id { font: var(--t-code-sm); color: var(--fg-3); }
.req-pill { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font: var(--t-meta); border-radius: 99px; padding: 1px 8px; text-transform: capitalize; }
.req-pill--decomposing { color: var(--status-running); background: rgba(20,184,166,.12); }
.req-pill--decomposed { color: var(--accent-text); background: var(--bg-base); border: 1px solid var(--border-default); }
.req-pill--in-flight { color: var(--status-running); background: rgba(20,184,166,.12); }
.req-pill--blocked { color: var(--status-blocked); background: rgba(239,68,68,.12); }
.req-title { font: 500 12.5px/1.4 var(--font-ui); color: var(--fg-1); margin-bottom: 8px; }
.req-proposed { display: flex; flex-direction: column; gap: 6px; margin-bottom: 9px; }
.req-pstory { display: flex; align-items: center; gap: 7px; }
.req-pstory-title { font: var(--t-body-sm); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.req-repo { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font: var(--t-code-sm); color: var(--fg-3); }
.req-repo--warn { color: var(--status-blocked); }
.req-empty { font: var(--t-body-sm); color: var(--fg-3); }
.req-actions { display: flex; gap: 8px; }
```

  (Reuse existing CSS vars; align colors with `.scard` / `.loop-status` / `.ni-card`.)

- [ ] **Step 5: Typecheck + full suite.** `rm -f *.tsbuildinfo && npm run typecheck && npx vitest run` — clean. (Renderer typecheck will catch a missing `requirements` prop at any `<Dock />` site or an unregistered icon name.)

- [ ] **Step 6: Commit.**

```bash
git add src/renderer/src/components/NewRequirementModal.tsx src/renderer/src/components/AgentDock.tsx src/renderer/src/lib/hiveView.ts src/renderer/src/App.tsx src/renderer/src/styles/ide.css
git commit -m "$(cat <<'EOF'
feat(hive): new-requirement modal + requirement cards in the Dock

+ New requirement writes a requirement (→ decompose job); requirement
cards show the status pill, grouped proposed stories (role + routed repo
with ⚠ on unknown repos), and Approve plan / Discard actions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Clean typecheck.** `rm -f *.tsbuildinfo && npm run typecheck` — no errors.

- [ ] **Step 2: Full test run.** `npx vitest run` — all suites green, including the new `manager/requirement`, `manager/decompose`, `manager/approve`, `manager/lane`, `manager/handlers`, the `parse` regression, and `hiveView` adapter tests.

- [ ] **Step 3: Spec cross-check.** Re-open `docs/specs/2026-06-09-hive-manager-llm-slice2b2-design.md` and confirm every decomposition/approval requirement is covered:
  - `proposed`/`decomposing` enums in both places (Task 1) ✓
  - read-only manager, hive owns writes (Tasks 4, 6) ✓
  - soft routing validation, unknown team kept + flagged (Tasks 4, 10, 11) ✓
  - parse failure → requirement `blocked` + `failed` event, no stories (Tasks 4, 6, 8 — `onResult`/`onFailure` route to `markBlocked`) ✓
  - zero repos → blocked ("no repos to route to") (Task 8 wiring, before enqueue) ✓
  - approve → pending + in-flight + `approved` event (Task 5) ✓
  - discard → delete proposed + requirement + `abandoned` event (Task 5) ✓
  - stale `decomposing` → `pending` on start (Task 8) ✓
  - channels match char-for-char across handlers/preload (Tasks 7, 9) ✓
  - UI: + New requirement modal, requirement card with pill + proposed stories + ⚠ + Approve/Discard (Task 11) ✓

- [ ] **Step 4: (Optional) Manual smoke.** Per the spec's Manual test: connect a project with ≥2 indexed repos, create a requirement spanning both → confirm proposed stories appear routed under the requirement (with a ⚠ on a deliberately bad team) → Approve → the 2b-1 loop runs each story in the correct repo. Kill the app mid-decompose → on restart the requirement is back to `pending`.
