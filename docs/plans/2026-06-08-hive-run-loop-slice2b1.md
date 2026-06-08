# Hive Autonomous Run Loop + Question Notifications (Slice 2b-1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Start/Stop loop auto-runs `pending` hive stories one at a time, and when a worker writes a question file the story goes to a new `needs-input` state with a desktop notification + a Dock answer box that re-runs the story with your answer.

**Architecture:** An interval-tick supervisor in the main process polls the active workspace's `.hive/state` for `pending` stories and drives the existing `runStory` serially (never auto-retrying blocked/review/needs-input). Question detection folds into the run-finish path (a `.hive/state/questions/<id>.md` written by the worker → `needs-input` outcome + notification). Answering appends a Q&A block to the story body and flips it back to `pending` so the loop re-runs it. State renders through the existing slice-1 watcher.

**Tech Stack:** Electron main (Node, `node:fs/promises`, `Notification`), TypeScript, Vitest (node env for main, happy-dom for renderer), React. Reuses slice-2a/2c `runStory`, `serializeStory`/`parseStory`, the runner's `isBusy`.

**Spec:** `docs/specs/2026-06-08-hive-autonomous-run-loop-slice2b1-design.md`

**Conventions:**
- CI runs on **node 22** — verify with `fnm exec --using=22 <cmd>` (fnm has 22.22.2). Before `npm run typecheck`: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete`.
- Single test: `fnm exec --using=22 npx vitest run <path>`. Full suite: `fnm exec --using=22 npx vitest run`.
- No `any`. Main tests `*.test.ts` (node env); renderer component tests use `// @vitest-environment happy-dom` + `@testing-library/react`.
- **Confirm `git branch --show-current` is `feat/hive-run-loop-slice2b1` before every commit.** Stage only the files each task names. (A user may switch branches in their terminal — always verify.)

---

## File Structure

**Create:**
- `src/main/hive/run/question.ts` (+ `.test.ts`) — read a pending question; apply an answer.
- `src/main/hive/run/notify.ts` (+ `.test.ts`) — Electron `Notification` wrapper (injected notifier).
- `src/main/hive/run/supervisor.ts` (+ `.test.ts`) — the Start/Stop interval loop.
- `src/renderer/src/lib/useHiveLoop.ts` — loop status + answer subscription hook.

**Modify:**
- `src/types/hive.ts` — `StoryStatus += 'needs-input'`; `STORY_STATUSES`; `HiveLoopStatus`; `HiveQuestion`.
- `src/main/hive/run/serialize.ts` — `nextStoryStatus` handles `needs-input`.
- `src/main/hive/run/writer.ts` — `writeRunFinish` handles the `needs-input` outcome.
- `src/main/hive/run/prompt.ts` — question rule in `COMMON`; `buildTaskPrompt` ctx gains `workspacePath`.
- `src/main/hive/run/handlers.ts` — `Outcome += needs-input`; question check + notify hook in `runStory`; loop/answer/questions IPC.
- `src/main/index.ts` — build the supervisor + wire question detection/notify + loop IPC.
- `src/preload/api.ts` + `src/preload/index.ts` — `window.hive.loop.*`, `window.hive.story.answer`, `window.hive.questions.list`.
- `src/renderer/src/lib/hiveView.ts` — surface `needs-input` stories (out of the normal board columns).
- `src/renderer/src/components/AgentDock.tsx` — Start/Stop + status on the Run tab; Needs-input answer panel.

---

## Task 1: Shared types

**Files:** Modify `src/types/hive.ts`

- [ ] **Step 1: Add `needs-input` to the status union + list, plus loop/question types**

In `src/types/hive.ts`, change the `StoryStatus` union to include `'needs-input'`:

```ts
export type StoryStatus =
  | 'pending'
  | 'assigned'
  | 'in-progress'
  | 'review'
  | 'merged'
  | 'blocked'
  | 'abandoned'
  | 'needs-input';
```

Add `'needs-input'` to the `STORY_STATUSES` array (so the parser accepts it — `parseStory` validates against this list). Append it after `'abandoned'`.

At the end of the file, append:

```ts
// ---------------------------------------------------------------------------
// Slice 2b-1 — autonomous run loop + questions
// ---------------------------------------------------------------------------

/** Pushed to the renderer on every loop state change. */
export interface HiveLoopStatus {
  running: boolean;
  /** Story id currently being worked, or null when idle/stopped. */
  currentStory: string | null;
}

/** A worker's blocking question, surfaced for the operator to answer. */
export interface HiveQuestion {
  storyId: string;
  question: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck`
Expected: clean (the new status value isn't referenced in exhaustive switches yet — `nextStoryStatus` and `hiveView.column` use it in later tasks; confirm typecheck still passes here because both have a `default`/fallthrough today. If `tsc` flags a non-exhaustive switch, that's Task 2 / Task 12's job — note it and proceed; do NOT add handling here).

- [ ] **Step 3: Commit**

```bash
git add src/types/hive.ts
git commit -m "feat(hive): needs-input status + loop/question types (slice 2b-1)"
```

---

## Task 2: Status transition + writer for `needs-input`

**Files:** Modify `src/main/hive/run/serialize.ts`, `src/main/hive/run/serialize.test.ts`, `src/main/hive/run/writer.ts`, `src/main/hive/run/writer.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/main/hive/run/serialize.test.ts`, add to the `nextStoryStatus` describe block:

```ts
  it('needs-input → needs-input', () =>
    expect(nextStoryStatus({ kind: 'needs-input' })).toBe('needs-input'));
```

In `src/main/hive/run/writer.test.ts`, add a case to the `writeRunFinish` describe (mirror the existing `no-commit` test's setup — it calls `writeRunStart` then `writeRunFinish`):

```ts
  it('needs-input → story needs-input, awaiting-answer note, needs-input event', async () => {
    await writeRunStart({
      workspacePath: ws, story, runId: 'run_q', featureBranch: 'feat/AUTH-3',
      worktree: '.hive/worktrees/AUTH-3', pid: 7, now: 't0',
    });
    await writeRunFinish({
      workspacePath: ws, storyId: 'AUTH-3', runId: 'run_q',
      outcome: { kind: 'needs-input' }, now: 't1',
    });
    const s = parseStory(await readFile(join(ws, '.hive/state/stories/AUTH-3.md'), 'utf8'), 'AUTH-3');
    expect(s.status).toBe('needs-input');
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"needs-input"');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/serialize.test.ts src/main/hive/run/writer.test.ts`
Expected: FAIL — `nextStoryStatus` doesn't accept `needs-input`; `writeRunFinish` doesn't either.

- [ ] **Step 3: Implement**

In `src/main/hive/run/serialize.ts`, extend `nextStoryStatus`'s param union and switch:

```ts
export function nextStoryStatus(
  outcome:
    | { kind: 'success' }
    | { kind: 'no-commit' }
    | { kind: 'failure' }
    | { kind: 'interrupted' }
    | { kind: 'needs-input' },
): StoryStatus {
  switch (outcome.kind) {
    case 'success':
      return 'review';
    case 'no-commit':
    case 'failure':
      return 'blocked';
    case 'interrupted':
      return 'pending';
    case 'needs-input':
      return 'needs-input';
  }
}
```

In `src/main/hive/run/writer.ts`, extend `writeRunFinish`'s `outcome` param union with `| { kind: 'needs-input' }`, and extend the `note` + `event`/`level` mapping:

```ts
  const note =
    outcome.kind === 'success' ? 'completed'
    : outcome.kind === 'no-commit' ? 'no changes produced'
    : outcome.kind === 'interrupted' ? 'stopped'
    : outcome.kind === 'needs-input' ? 'awaiting answer'
    : 'failed';
```

and:

```ts
  const level: HiveEvent['level'] = outcome.kind === 'success' ? 'ok' : 'warn';
  const event =
    outcome.kind === 'success' ? 'finished'
    : outcome.kind === 'needs-input' ? 'needs-input'
    : 'failed';
```

- [ ] **Step 4: Run to verify pass**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/serialize.test.ts src/main/hive/run/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/serialize.ts src/main/hive/run/serialize.test.ts src/main/hive/run/writer.ts src/main/hive/run/writer.test.ts
git commit -m "feat(hive): needs-input status transition + writer (slice 2b-1)"
```

---

## Task 3: Worker prompt — question rule + workspace path

**Files:** Modify `src/main/hive/run/prompt.ts`, `src/main/hive/run/prompt.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/main/hive/run/prompt.test.ts`, the `buildTaskPrompt` block builds `p` from `buildTaskPrompt(story(), { repoName, featureBranch })`. Change that call to pass the new ctx field and add assertions:

```ts
  const p = buildTaskPrompt(story(), {
    repoName: 'acme-web',
    featureBranch: 'feat/AUTH-3',
    workspacePath: '/ws',
  })
  // ...existing assertions stay...
  it('tells the worker where to write a blocking question', () => {
    expect(p).toContain('/ws/.hive/state/questions/AUTH-3.md')
    expect(p.toLowerCase()).toContain('question')
  })
```

Also add a `COMMON`-coverage assertion to the existing `resolveRolePrompt` block:

```ts
  it('built-ins mention the worktree boundary', () => {
    expect(BUILTIN_ROLE_PROMPTS.senior.toLowerCase()).toContain('worktree')
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/prompt.test.ts`
Expected: FAIL — `buildTaskPrompt` ctx has no `workspacePath`; the question path isn't rendered.

- [ ] **Step 3: Implement**

In `src/main/hive/run/prompt.ts`, soften `COMMON`'s outside-worktree clause so it doesn't contradict the question file, and keep it general:

```ts
const COMMON = [
  'You are an autonomous engineering agent working inside an isolated git',
  'worktree. You may edit files, run the project test command, and commit.',
  'When the acceptance criteria are met and tests pass, COMMIT your work with a',
  'clear message. Do not push, open PRs, or touch files outside this worktree',
  'except where your task explicitly instructs you to (e.g. writing a question',
  'file).',
].join(' ');
```

Extend `buildTaskPrompt`'s ctx type and add the question instruction block:

```ts
export function buildTaskPrompt(
  story: HiveStory,
  ctx: { repoName: string; featureBranch: string; workspacePath: string },
): string {
  const criteria =
    story.acceptanceCriteria.length > 0
      ? story.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')
      : '- [ ] (no acceptance criteria specified)';
  const questionPath = `${ctx.workspacePath}/.hive/state/questions/${story.id}.md`;
  return [
    `# Story ${story.id}: ${story.title}`,
    '',
    `Repo (team): ${ctx.repoName}`,
    `Feature branch (already checked out in this worktree): ${ctx.featureBranch}`,
    '',
    '## Description',
    story.body.trim() || '(no description)',
    '',
    '## Acceptance criteria',
    criteria,
    '',
    '## Definition of done',
    '1. Implement the change in this worktree.',
    '2. Run the project test command and make it pass.',
    '3. Commit your work on the current branch with a clear message.',
    '',
    '## If you are blocked',
    'If you cannot reasonably decide something yourself (ambiguous requirement,',
    'a destructive or irreversible choice, missing context), do NOT guess. Write',
    'a single clear question — and only the question — to this exact absolute',
    `path, then stop WITHOUT committing:`,
    `  ${questionPath}`,
    'A human will answer and the story will be re-run with your question and',
    'their answer included. This is the one file you may write outside the',
    'worktree.',
  ].join('\n');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/prompt.ts src/main/hive/run/prompt.test.ts
git commit -m "feat(hive): worker question-file instruction in task prompt (slice 2b-1)"
```

---

## Task 4: Question read + answer

**Files:** Create `src/main/hive/run/question.ts` + `src/main/hive/run/question.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/question.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readQuestion, answerQuestion } from './question';
import { serializeStory } from './serialize';
import { parseStory } from '../parse';
import type { HiveStory } from '../../../types/hive';

let ws: string;
const story: HiveStory = {
  id: 'AUTH-3', title: 'Add login', status: 'needs-input', role: 'senior', points: 0,
  team: '', dependsOn: [], acceptanceCriteria: ['a'], createdAt: 't', updatedAt: 't',
  body: 'Implement login.',
};

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'hive-q-'));
  await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
  await mkdir(join(ws, '.hive', 'state', 'questions'), { recursive: true });
  await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
  await writeFile(join(ws, '.hive', 'state', 'stories', 'AUTH-3.md'), serializeStory(story));
});
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe('readQuestion', () => {
  it('returns the question text when present', async () => {
    await writeFile(join(ws, '.hive/state/questions/AUTH-3.md'), 'Which DB?\n', 'utf8');
    expect(await readQuestion(ws, 'AUTH-3')).toBe('Which DB?');
  });
  it('returns null when absent', async () => {
    expect(await readQuestion(ws, 'AUTH-3')).toBeNull();
  });
});

describe('answerQuestion', () => {
  it('appends a Q&A block to the body, deletes the file, sets pending, logs answered', async () => {
    await writeFile(join(ws, '.hive/state/questions/AUTH-3.md'), 'Which DB?', 'utf8');
    await answerQuestion(ws, 'AUTH-3', 'Use Postgres.', 't2');

    const s = parseStory(await readFile(join(ws, '.hive/state/stories/AUTH-3.md'), 'utf8'), 'AUTH-3');
    expect(s.status).toBe('pending');
    expect(s.body).toContain('Which DB?');
    expect(s.body).toContain('Use Postgres.');

    // question file deleted
    await expect(access(join(ws, '.hive/state/questions/AUTH-3.md'))).rejects.toThrow();

    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"answered"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/question.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/question.ts`:

```ts
/**
 * Worker question read/answer (slice 2b-1). A blocked worker writes a question
 * to `.hive/state/questions/<storyId>.md` and stops. The operator answers; the
 * answer is appended to the story body (so the next run's task prompt carries
 * it), the question file is removed, and the story flips back to `pending` for
 * the loop to re-run.
 */

import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseStory } from '../parse';
import { serializeStory, eventLine } from './serialize';

function questionPath(ws: string, storyId: string): string {
  return join(ws, '.hive', 'state', 'questions', `${storyId}.md`);
}
function storyPath(ws: string, storyId: string): string {
  return join(ws, '.hive', 'state', 'stories', `${storyId}.md`);
}

/** The pending question for a story, or null when none. */
export async function readQuestion(ws: string, storyId: string): Promise<string | null> {
  try {
    const text = await readFile(questionPath(ws, storyId), 'utf8');
    return text.trim();
  } catch {
    return null;
  }
}

/**
 * Apply an answer: append a Q&A block to the story body, delete the question
 * file, set the story back to `pending`, append an `answered` event.
 */
export async function answerQuestion(
  ws: string,
  storyId: string,
  answer: string,
  now: string,
): Promise<void> {
  const question = (await readQuestion(ws, storyId)) ?? '';
  const current = parseStory(await readFile(storyPath(ws, storyId), 'utf8'), storyId);
  const qa = [
    current.body.trim(),
    '',
    '## Prior question',
    question || '(question file missing)',
    '',
    '## Answer',
    answer.trim(),
  ].join('\n');
  await writeFile(
    storyPath(ws, storyId),
    serializeStory({ ...current, status: 'pending', body: qa, updatedAt: now }),
    'utf8',
  );
  await rm(questionPath(ws, storyId), { force: true });
  await appendFile(
    join(ws, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'user', event: 'answered', detail: storyId, level: 'info' }) + '\n',
    'utf8',
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/question.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/question.ts src/main/hive/run/question.test.ts
git commit -m "feat(hive): question read + answer flow (slice 2b-1)"
```

---

## Task 5: Wire question detection into the run finish

**Files:** Modify `src/main/hive/run/handlers.ts`, `src/main/hive/run/handlers.test.ts`

This makes `runStory` (a) thread `workspacePath` into the task prompt and (b) check for a question file on exit → `needs-input` outcome + a notify hook.

- [ ] **Step 1: Write failing tests**

In `src/main/hive/run/handlers.test.ts`, the `deps()` factory needs two new fields. Add to it:

```ts
    readQuestion: vi.fn(async () => null),
    onNeedsInput: vi.fn(),
```

Add a test to the `runStory` describe:

```ts
  it('exit 0 with a question file → finish(needs-input) + onNeedsInput', async () => {
    const onNeedsInput = vi.fn();
    const d = deps({
      readQuestion: vi.fn(async () => 'Which DB?'),
      onNeedsInput,
    });
    await runStory(d, 'AUTH-3');
    expect(d.writeRunFinish).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: 'needs-input' } }),
    );
    expect(onNeedsInput).toHaveBeenCalledWith({ storyId: 'AUTH-3', question: 'Which DB?' });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Expected: FAIL — `RunDeps` lacks `readQuestion`/`onNeedsInput`; the question branch doesn't exist.

- [ ] **Step 3: Implement**

In `src/main/hive/run/handlers.ts`:

Extend the `Outcome` type:

```ts
type Outcome =
  | { kind: 'success' } | { kind: 'no-commit' } | { kind: 'failure' }
  | { kind: 'interrupted' } | { kind: 'needs-input' };
```

Add two fields to `RunDeps` (import `HiveQuestion` from `../../../types/hive`):

```ts
  /** Read a pending question file written by the worker, or null. */
  readQuestion: (workspacePath: string, storyId: string) => Promise<string | null>;
  /** Notify the operator a worker is blocked on a question. */
  onNeedsInput: (q: HiveQuestion) => void;
```

Thread `workspacePath` into the task prompt (the `buildTaskPrompt` call):

```ts
    const taskPrompt = buildTaskPrompt(story, {
      repoName: story.team,
      featureBranch: branch,
      workspacePath,
    });
```

In the `onExit` ladder, check the question file FIRST:

```ts
          onExit: (result) => {
            void (async () => {
              let outcome: Outcome;
              const question = await deps.readQuestion(workspacePath, storyId);
              if (question !== null) {
                outcome = { kind: 'needs-input' };
                deps.onNeedsInput({ storyId, question });
              } else if (result.signal !== null) {
                outcome = { kind: 'interrupted' };
              } else if (result.code === 0) {
                outcome = (await deps.hasNewCommit(wt)) ? { kind: 'success' } : { kind: 'no-commit' };
              } else {
                outcome = { kind: 'failure' };
              }
              try {
                await deps.writeRunFinish({ workspacePath, storyId, runId, outcome, now: deps.now() });
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('hive run: writeRunFinish failed', err);
              }
              status('exited', { outcome: outcome.kind });
              resolve();
            })();
          },
```

Note: `HiveRunStatusEvent.outcome` is a string union; `needs-input` must be allowed there. Check `src/types/hive.ts` `HiveRunStatusEvent.outcome` — if it's `'success' | 'no-commit' | 'failure' | 'interrupted'`, add `| 'needs-input'` to it (small edit in `types/hive.ts`; stage it with this task).

- [ ] **Step 4: Run to verify pass**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Then `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck`.
Expected: handlers tests PASS. Typecheck may fail on `src/main/index.ts` (it doesn't yet supply `readQuestion`/`onNeedsInput`) — that's Task 9. Confirm the failure is ONLY index.ts; report it.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/handlers.ts src/main/hive/run/handlers.test.ts src/types/hive.ts
git commit -m "feat(hive): detect question file on run exit → needs-input (slice 2b-1)"
```

---

## Task 6: Desktop notification wrapper

**Files:** Create `src/main/hive/run/notify.ts` + `src/main/hive/run/notify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/notify.test.ts` (inject the notifier so Electron isn't needed):

```ts
import { describe, it, expect, vi } from 'vitest';

import { notifyNeedsInput, type Notifier } from './notify';

describe('notifyNeedsInput', () => {
  it('shows a notification with the story + question', () => {
    const shown: Array<{ title: string; body: string }> = [];
    const notifier: Notifier = {
      supported: () => true,
      show: (title, body) => shown.push({ title, body }),
    };
    notifyNeedsInput(notifier, { storyId: 'AUTH-3', question: 'Which DB?' });
    expect(shown).toHaveLength(1);
    expect(shown[0].title.toLowerCase()).toContain('input');
    expect(shown[0].body).toContain('AUTH-3');
    expect(shown[0].body).toContain('Which DB?');
  });

  it('no-ops when notifications are unsupported', () => {
    const notifier: Notifier = { supported: () => false, show: vi.fn() };
    notifyNeedsInput(notifier, { storyId: 'X', question: 'Q' });
    expect(notifier.show).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/notify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/notify.ts`:

```ts
/**
 * Desktop notification for worker questions (slice 2b-1). The Electron
 * `Notification` is wrapped behind a `Notifier` so the logic is testable
 * without Electron; `electronNotifier()` is the production binding.
 */

import { Notification } from 'electron';

import type { HiveQuestion } from '../../../types/hive';

export interface Notifier {
  supported: () => boolean;
  show: (title: string, body: string) => void;
}

/** Production notifier backed by Electron's Notification API. */
export function electronNotifier(onClick?: () => void): Notifier {
  return {
    supported: () => Notification.isSupported(),
    show: (title, body) => {
      const n = new Notification({ title, body });
      if (onClick) n.on('click', onClick);
      n.show();
    },
  };
}

/** Fire a "needs input" notification (no-op when unsupported). */
export function notifyNeedsInput(notifier: Notifier, q: HiveQuestion): void {
  if (!notifier.supported()) return;
  notifier.show('Hive needs input', `${q.storyId}: ${q.question}`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/notify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/notify.ts src/main/hive/run/notify.test.ts
git commit -m "feat(hive): desktop notification for worker questions (slice 2b-1)"
```

---

## Task 7: The supervisor (Start/Stop loop)

**Files:** Create `src/main/hive/run/supervisor.ts` + `src/main/hive/run/supervisor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/supervisor.test.ts` (inject `schedule` to drive ticks manually — no real timers):

```ts
import { describe, it, expect, vi } from 'vitest';

import { createSupervisor, type SupervisorDeps } from './supervisor';

function harness(over: Partial<SupervisorDeps> = {}) {
  let next: (() => void) | null = null;
  const deps: SupervisorDeps = {
    getPendingStoryIds: vi.fn(async () => ['S1', 'S2']),
    isRunnerBusy: vi.fn(() => false),
    runStory: vi.fn(async () => {}),
    onStatus: vi.fn(),
    schedule: (_ms, fn) => { next = fn; },
    ...over,
  };
  const sup = createSupervisor(deps);
  // run the most recently scheduled tick
  const tick = (): void => { const fn = next; next = null; fn?.(); };
  return { sup, deps, tick };
}

describe('createSupervisor', () => {
  it('starts the next pending story when the runner is free', async () => {
    const { sup, deps, tick } = harness();
    sup.start();
    tick();
    await Promise.resolve();
    expect(deps.runStory).toHaveBeenCalledWith('S1');
    expect(sup.status()).toEqual({ running: true, currentStory: 'S1' });
  });

  it('does not start a story while the runner is busy', async () => {
    const { sup, deps, tick } = harness({ isRunnerBusy: vi.fn(() => true) });
    sup.start();
    tick();
    await Promise.resolve();
    expect(deps.runStory).not.toHaveBeenCalled();
  });

  it('goes idle (currentStory null) when there are no pending stories', async () => {
    const { sup, deps, tick } = harness({ getPendingStoryIds: vi.fn(async () => []) });
    sup.start();
    tick();
    await Promise.resolve();
    expect(deps.runStory).not.toHaveBeenCalled();
    expect(sup.status().currentStory).toBeNull();
  });

  it('stop() halts new starts and reports running:false', async () => {
    const { sup, deps, tick } = harness();
    sup.start();
    sup.stop();
    tick();
    await Promise.resolve();
    expect(deps.runStory).not.toHaveBeenCalled();
    expect(sup.status().running).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/supervisor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/supervisor.ts`:

```ts
/**
 * Autonomous run loop (slice 2b-1). A Start/Stop interval tick that runs
 * `pending` stories serially via the existing run orchestration — one at a
 * time, never auto-retrying a non-pending story. `schedule` is injected so the
 * tick is testable without real timers; production passes an unref'd setTimeout.
 */

import type { HiveLoopStatus } from '../../../types/hive';

export interface SupervisorDeps {
  /** Pending story ids in run order, for the active workspace. */
  getPendingStoryIds: () => Promise<string[]>;
  isRunnerBusy: () => boolean;
  /** Existing run orchestration; fire-and-forget per tick. */
  runStory: (storyId: string) => Promise<void>;
  onStatus: (s: HiveLoopStatus) => void;
  /** Schedule the next tick after `ms`. */
  schedule: (ms: number, fn: () => void) => void;
}

export interface Supervisor {
  start(): void;
  stop(): void;
  status(): HiveLoopStatus;
}

/** Tick cadence while working vs idle (idle backs off). */
export const ACTIVE_TICK_MS = 1500;
export const IDLE_TICK_MS = 8000;

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  let running = false;
  let currentStory: string | null = null;

  const push = (): void => deps.onStatus({ running, currentStory });

  const tick = (): void => {
    if (!running) return;
    if (deps.isRunnerBusy()) {
      // A run is in flight — leave currentStory as-is and re-check soon.
      deps.schedule(ACTIVE_TICK_MS, tick);
      return;
    }
    void (async () => {
      let pending: string[] = [];
      try {
        pending = await deps.getPendingStoryIds();
      } catch {
        pending = [];
      }
      if (!running) return;
      const next = pending[0];
      if (next !== undefined) {
        currentStory = next;
        push();
        void deps.runStory(next).catch(() => undefined);
        deps.schedule(ACTIVE_TICK_MS, tick);
      } else {
        currentStory = null;
        push();
        deps.schedule(IDLE_TICK_MS, tick);
      }
    })();
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      push();
      deps.schedule(0, tick);
    },
    stop(): void {
      running = false;
      currentStory = null;
      push();
    },
    status(): HiveLoopStatus {
      return { running, currentStory };
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/supervisor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/supervisor.ts src/main/hive/run/supervisor.test.ts
git commit -m "feat(hive): autonomous run-loop supervisor (slice 2b-1)"
```

---

## Task 8: Loop + answer + questions IPC

**Files:** Modify `src/main/hive/run/handlers.ts`, `src/main/hive/run/handlers.test.ts`

Add the IPC surface. Keep the orchestration thin and DI'd; `registerHiveLoopHandlers` wires channels.

- [ ] **Step 1: Write the failing test**

In `src/main/hive/run/handlers.test.ts`, add:

```ts
import { HIVE_LOOP_CHANNELS } from './handlers';

describe('loop channel constants', () => {
  it('are the agreed strings', () => {
    expect(HIVE_LOOP_CHANNELS.start).toBe('ipc:hive:loop:start');
    expect(HIVE_LOOP_CHANNELS.stop).toBe('ipc:hive:loop:stop');
    expect(HIVE_LOOP_CHANNELS.status).toBe('ipc:hive:loop:status');
    expect(HIVE_LOOP_CHANNELS.answer).toBe('ipc:hive:answer-question');
    expect(HIVE_LOOP_CHANNELS.questions).toBe('ipc:hive:questions:list');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Expected: FAIL — `HIVE_LOOP_CHANNELS` not exported.

- [ ] **Step 3: Implement**

In `src/main/hive/run/handlers.ts`, add the constants + a registration that takes a supervisor + answer/list deps (import `Supervisor` from `./supervisor`, `HiveLoopStatus`/`HiveQuestion` from types):

```ts
export const HIVE_LOOP_CHANNELS = {
  start: 'ipc:hive:loop:start',
  stop: 'ipc:hive:loop:stop',
  status: 'ipc:hive:loop:status',
  answer: 'ipc:hive:answer-question',
  questions: 'ipc:hive:questions:list',
} as const;

export interface LoopDeps {
  supervisor: Supervisor;
  /** Apply an answer to a story's pending question. */
  answerQuestion: (storyId: string, answer: string) => Promise<void>;
  /** Outstanding questions across the active workspace (for late subscribers). */
  listQuestions: () => Promise<HiveQuestion[]>;
}

export function registerHiveLoopHandlers(deps: LoopDeps): () => void {
  ipcMain.handle(HIVE_LOOP_CHANNELS.start, () => { deps.supervisor.start(); });
  ipcMain.handle(HIVE_LOOP_CHANNELS.stop, () => { deps.supervisor.stop(); });
  ipcMain.handle(HIVE_LOOP_CHANNELS.status, (): HiveLoopStatus => deps.supervisor.status());
  ipcMain.handle(HIVE_LOOP_CHANNELS.answer, (_e, args: { storyId: string; answer: string }) =>
    deps.answerQuestion(args.storyId, args.answer),
  );
  ipcMain.handle(HIVE_LOOP_CHANNELS.questions, () => deps.listQuestions());
  return () => {
    for (const c of Object.values(HIVE_LOOP_CHANNELS)) ipcMain.removeHandler(c);
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/handlers.ts src/main/hive/run/handlers.test.ts
git commit -m "feat(hive): loop + answer + questions IPC handlers (slice 2b-1)"
```

---

## Task 9: Main wiring

**Files:** Modify `src/main/index.ts`

No new unit test (integration wiring); verified by typecheck + full suite + the manual e2e. Read the existing hive-run wiring (`registerHiveRunHandlers({...})`) and the `event:hive:run:*` push mechanism (`hiveSend`).

- [ ] **Step 1: Imports + the new event constant**

Add imports (merge `registerHiveLoopHandlers` into the existing `./hive/run/handlers` import):

```ts
import { registerHiveLoopHandlers } from './hive/run/handlers';
import { createSupervisor } from './hive/run/supervisor';
import { electronNotifier, notifyNeedsInput } from './hive/run/notify';
import { readQuestion, answerQuestion } from './hive/run/question';
import { Notification } from 'electron';   // if not already imported
import { readdir } from 'node:fs/promises'; // if not already imported
```

Add a module-level teardown var + the loop-status event channel:

```ts
let teardownHiveLoopHandlers: (() => void) | undefined;
const EVT_HIVE_LOOP_STATUS = 'event:hive:loop:status';
const EVT_HIVE_RUN_QUESTION = 'event:hive:run:question';
```

- [ ] **Step 2: Supply the new RunDeps fields**

In the existing `registerHiveRunHandlers({...})` deps, add (the `hiveSend` + `mainWindow` focus helpers already exist; `activeWorkspacePath()` exists):

```ts
    readQuestion: (workspacePath, storyId) => readQuestion(workspacePath, storyId),
    onNeedsInput: (q) => {
      hiveSend(EVT_HIVE_RUN_QUESTION, q);
      notifyNeedsInput(
        electronNotifier(() => {
          if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
        }),
        q,
      );
    },
```

- [ ] **Step 3: Build + register the supervisor**

After the run handlers are registered, add:

```ts
  const hiveSupervisor = createSupervisor({
    getPendingStoryIds: async () => {
      const ws = activeWorkspacePath();
      if (!ws) return [];
      try {
        const dir = join(ws, '.hive', 'state', 'stories');
        const names = await readdir(dir);
        const stories = await Promise.all(
          names.filter((n) => n.endsWith('.md')).map(async (n) => {
            const id = n.slice(0, -3);
            try {
              return parseStory(await readFile(join(dir, n), 'utf8'), id);
            } catch {
              return null;
            }
          }),
        );
        return stories
          .filter((s): s is NonNullable<typeof s> => s !== null && s.status === 'pending')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((s) => s.id);
      } catch {
        return [];
      }
    },
    isRunnerBusy: () => hiveRunner.isBusy(),
    runStory: (storyId) => runStory(/* same RunDeps object used above */ hiveRunDeps, storyId),
    onStatus: (s) => hiveSend(EVT_HIVE_LOOP_STATUS, s),
    schedule: (ms, fn) => { const t = setTimeout(fn, ms); t.unref(); },
  });

  teardownHiveLoopHandlers = registerHiveLoopHandlers({
    supervisor: hiveSupervisor,
    answerQuestion: async (storyId, answer) => {
      const ws = activeWorkspacePath();
      if (!ws) return;
      await answerQuestion(ws, storyId, answer, new Date().toISOString());
    },
    listQuestions: async () => {
      const ws = activeWorkspacePath();
      if (!ws) return [];
      try {
        const dir = join(ws, '.hive', 'state', 'questions');
        const names = await readdir(dir);
        return Promise.all(
          names.filter((n) => n.endsWith('.md')).map(async (n) => {
            const storyId = n.slice(0, -3);
            const question = (await readQuestion(ws, storyId)) ?? '';
            return { storyId, question };
          }),
        );
      } catch {
        return [];
      }
    },
  });
```

IMPORTANT — `runStory(hiveRunDeps, storyId)`: the existing code calls `registerHiveRunHandlers({...})` with an inline deps object. To reuse the SAME deps for the supervisor's `runStory`, extract that inline object into a named `const hiveRunDeps = {...}` first, pass it to `registerHiveRunHandlers(hiveRunDeps)`, and reuse it here. (Read the current `registerHiveRunHandlers({...})` call and lift its argument to a named const.) `runStory` is exported from `./hive/run/handlers` — import it if not already.

- [ ] **Step 4: Teardown on quit**

In the `before-quit` block, next to the other teardowns, add:

```ts
  hiveSupervisor.stop();
  teardownHiveLoopHandlers?.();
```

- [ ] **Step 5: Typecheck + full suite**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck && fnm exec --using=22 npx vitest run`
Expected: clean + green (report count). Fix any mismatch against the real `RunDeps`/`LoopDeps`/`createSupervisor` shapes by reading them — no `any`.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(hive): wire supervisor + question detection + loop IPC in main (slice 2b-1)"
```

---

## Task 10: Preload bridge

**Files:** Modify `src/preload/api.ts`, `src/preload/index.ts`

Mirror the existing `run`/`workspace`/`story` bridges.

- [ ] **Step 1: Types in `api.ts`**

Add to `api.ts`:

```ts
export type HiveLoopStatusHandler = (s: import('../types/hive').HiveLoopStatus) => void;
export type HiveQuestionHandler = (q: import('../types/hive').HiveQuestion) => void;

export interface HiveLoopBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<import('../types/hive').HiveLoopStatus>;
  onStatus(handler: HiveLoopStatusHandler): () => void;
}
```

Extend `HiveStoryBridge` with `answer`, add a `questions` member + loop member to `HiveBridge`:

```ts
// in HiveStoryBridge:
  answer(storyId: string, answer: string): Promise<void>;

// in HiveBridge:
  loop: HiveLoopBridge;
  questions: { list(): Promise<import('../types/hive').HiveQuestion[]>; onQuestion(handler: HiveQuestionHandler): () => void };
```

- [ ] **Step 2: Implementation in `index.ts`**

Add channel constants near the others:

```ts
const HIVE_LOOP = {
  start: 'ipc:hive:loop:start',
  stop: 'ipc:hive:loop:stop',
  status: 'ipc:hive:loop:status',
  answer: 'ipc:hive:answer-question',
  questions: 'ipc:hive:questions:list',
  evtStatus: 'event:hive:loop:status',
  evtQuestion: 'event:hive:run:question',
} as const;
```

Add to the `story` bridge object: `answer: (storyId, answer) => ipcRenderer.invoke(HIVE_LOOP.answer, { storyId, answer })`.

Add `loop` + `questions` members to the `api` object:

```ts
  loop: {
    start: () => ipcRenderer.invoke(HIVE_LOOP.start),
    stop: () => ipcRenderer.invoke(HIVE_LOOP.stop),
    status: () => ipcRenderer.invoke(HIVE_LOOP.status),
    onStatus: (handler: import('./api').HiveLoopStatusHandler) => {
      const fn = (_e: unknown, s: import('../types/hive').HiveLoopStatus): void => handler(s);
      ipcRenderer.on(HIVE_LOOP.evtStatus, fn);
      return () => ipcRenderer.removeListener(HIVE_LOOP.evtStatus, fn);
    },
  },
  questions: {
    list: () => ipcRenderer.invoke(HIVE_LOOP.questions),
    onQuestion: (handler: import('./api').HiveQuestionHandler) => {
      const fn = (_e: unknown, q: import('../types/hive').HiveQuestion): void => handler(q);
      ipcRenderer.on(HIVE_LOOP.evtQuestion, fn);
      return () => ipcRenderer.removeListener(HIVE_LOOP.evtQuestion, fn);
    },
  },
```

- [ ] **Step 3: Verify channel parity**

Confirm character-for-character against `HIVE_LOOP_CHANNELS` (handlers.ts) and `EVT_HIVE_LOOP_STATUS`/`EVT_HIVE_RUN_QUESTION` (index.ts). Report the comparison.

- [ ] **Step 4: Typecheck + full suite**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck && fnm exec --using=22 npx vitest run`
Expected: clean + green.

- [ ] **Step 5: Commit**

```bash
git add src/preload/api.ts src/preload/index.ts
git commit -m "feat(hive): preload loop/answer/questions bridge (slice 2b-1)"
```

---

## Task 11: hiveView — surface `needs-input`

**Files:** Modify `src/renderer/src/lib/hiveView.ts`, `src/renderer/src/lib/hiveView.test.ts`

`column()` currently maps unknown statuses to `pending`. `needs-input` stories must NOT clutter the pending column — they belong in a dedicated surface. Add a `toNeedsInput` extractor and exclude `needs-input` from `toBoard`.

- [ ] **Step 1: Write the failing test**

In `src/renderer/src/lib/hiveView.test.ts`, add:

```ts
import { toNeedsInput } from './hiveView'

it('toNeedsInput returns only needs-input stories', () => {
  const stories = [
    { id: 'A', title: 'a', status: 'needs-input', role: 'senior', points: 0, team: '', dependsOn: [], acceptanceCriteria: [], createdAt: '', updatedAt: '', body: '' },
    { id: 'B', title: 'b', status: 'pending', role: 'senior', points: 0, team: '', dependsOn: [], acceptanceCriteria: [], createdAt: '', updatedAt: '', body: '' },
  ] as const
  const out = toNeedsInput(stories as never)
  expect(out.map((s) => s.id)).toEqual(['A'])
})

it('toBoard excludes needs-input stories from the pending column', () => {
  const stories = [
    { id: 'A', title: 'a', status: 'needs-input', role: 'senior', points: 0, team: '', dependsOn: [], acceptanceCriteria: [], createdAt: '', updatedAt: '', body: '' },
  ] as const
  const board = toBoard(stories as never)
  expect(board.pending.find((s) => s.id === 'A')).toBeUndefined()
})
```

(Ensure `toBoard` is imported in the test — it already is.)

- [ ] **Step 2: Run to verify failure**

Run: `fnm exec --using=22 npx vitest run src/renderer/src/lib/hiveView.test.ts`
Expected: FAIL — `toNeedsInput` missing; `toBoard` still buckets needs-input into pending.

- [ ] **Step 3: Implement**

In `src/renderer/src/lib/hiveView.ts`:

In `toBoard`, skip `needs-input` stories (filter them out before bucketing — read the current `toBoard` and add a `.filter((s) => s.status !== 'needs-input')` over the input, or `continue` when `status === 'needs-input'` in the loop).

Add the extractor (reuse the existing `toSeedStory` mapper the file already uses for board cards):

```ts
/** needs-input stories, as board-card shapes, for the Dock answer panel. */
export function toNeedsInput(stories: readonly HiveStory[]): Story[] {
  return stories.filter((s) => s.status === 'needs-input').map(toSeedStory)
}
```

(If `toSeedStory` isn't exported/!named that, use whatever the file's existing hive-story→seed-card mapper is; read the file.)

- [ ] **Step 4: Run to verify pass**

Run: `fnm exec --using=22 npx vitest run src/renderer/src/lib/hiveView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/hiveView.ts src/renderer/src/lib/hiveView.test.ts
git commit -m "feat(hive): surface needs-input stories out of the board (slice 2b-1)"
```

---

## Task 12: Renderer — loop hook + Start/Stop + answer panel

**Files:** Create `src/renderer/src/lib/useHiveLoop.ts`; Modify `src/renderer/src/components/AgentDock.tsx`

- [ ] **Step 1: Loop/question hook**

Create `src/renderer/src/lib/useHiveLoop.ts`:

```ts
import { useEffect, useState } from 'react'

import type { HiveLoopStatus, HiveQuestion } from '../../../types/hive'

export interface HiveLoopState {
  status: HiveLoopStatus
  /** Latest question text per story id (from the push event + initial list). */
  questions: Record<string, string>
}

/** Subscribe to loop status + worker questions; expose start/stop/answer. */
export function useHiveLoop(): HiveLoopState & {
  start: () => Promise<void>
  stop: () => Promise<void>
  answer: (storyId: string, answer: string) => Promise<void>
} {
  const [status, setStatus] = useState<HiveLoopStatus>({ running: false, currentStory: null })
  const [questions, setQuestions] = useState<Record<string, string>>({})

  useEffect(() => {
    const loop = window.hive?.loop
    const q = window.hive?.questions
    if (!loop || !q) return
    void loop.status().then(setStatus).catch(() => undefined)
    void q.list().then((list) => {
      setQuestions(Object.fromEntries(list.map((x: HiveQuestion) => [x.storyId, x.question])))
    }).catch(() => undefined)
    const offStatus = loop.onStatus(setStatus)
    const offQ = q.onQuestion((x) => setQuestions((prev) => ({ ...prev, [x.storyId]: x.question })))
    return () => { offStatus(); offQ() }
  }, [])

  return {
    status,
    questions,
    start: async () => { await window.hive?.loop?.start() },
    stop: async () => { await window.hive?.loop?.stop() },
    answer: async (storyId, answer) => {
      await window.hive?.story?.answer(storyId, answer)
      setQuestions((prev) => { const next = { ...prev }; delete next[storyId]; return next })
    },
  }
}
```

- [ ] **Step 2: Wire Start/Stop + status + answer panel into AgentDock**

In `src/renderer/src/components/AgentDock.tsx`:
- Import `useHiveLoop`, `toNeedsInput` (from `../lib/hiveView`), and (if not present) `useState`.
- In `Dock`, add `const loop = useHiveLoop()` and read the live stories for needs-input: the Dock already gets `board` (derived) — but needs-input stories are excluded from the board now, so pass the raw hive stories in. The simplest source: the Dock receives `board: Board`; add a `needsInput: Story[]` prop computed in `App.tsx` via `toNeedsInput(hiveSnapshot.stories)` and thread it down (mirror how `board` is passed). In `App.tsx`, where `liveBoard = toBoard(hiveSnapshot.stories)` is computed, add `const liveNeedsInput = useMemo(() => toNeedsInput(hiveSnapshot.stories), [hiveSnapshot.stories])` and pass `needsInput={liveNeedsInput}` to `<Dock .../>`. Add `needsInput: Story[]` to `DockProps`.
- On the **Run tab**, render a Start/Stop control + status when a workspace is connected:

```tsx
{hiveConnection.state === 'connected' && (
  <div className="loop-bar">
    {loop.status.running ? (
      <Btn kind="amber" sm icon="square" onClick={() => void loop.stop()}>Stop loop</Btn>
    ) : (
      <Btn kind="cta" sm icon="play" onClick={() => void loop.start()}>Start loop</Btn>
    )}
    <span className="loop-status">
      {loop.status.running
        ? (loop.status.currentStory ? `Working on ${loop.status.currentStory}` : 'Idle — waiting for stories')
        : 'Stopped'}
    </span>
  </div>
)}
```

- Render the **Needs-input answer panel** (on the Run tab, above the roster) for each `needsInput` story:

```tsx
{needsInput.length > 0 && (
  <div className="needs-input">
    <div className="ni-head">Needs input</div>
    {needsInput.map((s) => (
      <NeedsInputCard
        key={s.id}
        story={s}
        question={loop.questions[s.id] ?? ''}
        onAnswer={(text) => void loop.answer(s.id, text)}
      />
    ))}
  </div>
)}
```

Add a small `NeedsInputCard` component in the same file (a question line + a textarea + a Send button that calls `onAnswer` and clears). Use the `ns-*`/`np-*` styling tokens already in `ide.css` (e.g. `.ns-input` for the textarea). Add minimal CSS for `.loop-bar`, `.loop-status`, `.needs-input`, `.ni-head` to `src/renderer/src/styles/ide.css` matching the dock's existing dark style (commit the css with this task).

- [ ] **Step 3: Typecheck + full suite**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck && fnm exec --using=22 npx vitest run`
Expected: clean + green (report count). No renderer test required for the Dock wiring; the suite confirms nothing else broke.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/useHiveLoop.ts src/renderer/src/components/AgentDock.tsx src/renderer/src/App.tsx src/renderer/src/styles/ide.css
git commit -m "feat(hive): loop Start/Stop + status + needs-input answer panel (slice 2b-1)"
```

---

## Task 13: Full verification + manual end-to-end

**Files:** none (verification only).

- [ ] **Step 1: Full CI job under node 22**

Run:
```
find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete
fnm exec --using=22 npm ci
fnm exec --using=22 npm run typecheck
fnm exec --using=22 npm test
fnm exec --using=22 npm run build
```
Expected: all exit 0; tests pass.

- [ ] **Step 2: Manual end-to-end (documented; run by the executor)**

1. `npm run dev`. Open a project (its workspace auto-connected). Author two simple stories (e.g. "Add A.md with text a", "Add B.md with text b").
2. Dock → **Run** tab → **Start loop**. Both stories run **serially** (status shows "Working on <id>"), each lands in **review**, without clicking Run. Verify both files + commits exist in their worktrees.
3. Author a story whose description forces a question, e.g. *"Before doing anything, you MUST ask which database to use — write the question and stop."* Start the loop (or it picks it up) → the story goes to **Needs input**, a **desktop notification** fires, and the question appears in the Dock's Needs-input panel.
4. Type an answer → **Send** → the story flips to pending → the loop re-runs it (now with the Q&A in its body) → it completes.
5. **Stop loop** while a run is in flight → the current run finishes and writes its state; no new run starts.
6. Quit mid-loop → the child is reaped, no orphan `claude` process.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore(hive): slice-2b1 verification fixups"
```
(Skip if nothing changed.)

---

## Notes for the executor

- **Serial only.** The supervisor runs ONE story at a time and relies on `hiveRunner.isBusy()`. Do not add concurrency — that's a later slice.
- **Never auto-retry.** The loop only ever starts `pending` stories. A run that ends `blocked`/`review`/`needs-input` is left alone — the loop advances to the next pending story. Don't add retry logic.
- **The slice-1 watcher does the board.** Writing story files moves cards; you only add the loop tick, the question/answer writes, and the loop-status/question pushes. Keep `serializeStory` round-trip-clean.
- **The question file is the worker's one allowed write outside its worktree** — the task prompt says so; don't tighten `COMMON` back to forbid it.
- **Reuse the same `RunDeps`** for both `registerHiveRunHandlers` and the supervisor's `runStory` (lift the inline deps object to a named const in `index.ts`).
- **Channel strings must match** preload ↔ main exactly (typecheck won't catch a mismatch) — verify them.
