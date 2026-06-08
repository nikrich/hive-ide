# Hive native orchestration — Slice 2b-1: autonomous run loop + question notifications

**Date:** 2026-06-08
**Status:** Approved (design), pending implementation plan
**Track:** Native hive orchestration in the IDE (slice 2 of 4 — the run-loop sub-slice)

## Context

Shipped so far:
- **Slice 1** — read-only state viewer (`.hive/state/**` + watcher → Dock board / log).
- **Slice 2a** — run one worker on a story (Run button → `claude` worker in an isolated worktree → reap → write state). Re-run is idempotent (worktree cleanup).
- **Slice 2c** — UI workspace bootstrap + story authoring; team-aware repo resolution.

Today the operator clicks **Run** per story. The "set and forget" orchestrator — the manager loop — is unbuilt. The user asked for two things while testing 2c:
1. **Hive should decide where work runs** (not a human-picked repo). The Team picker was removed; an unassigned story currently falls back to the project's first repo.
2. **Notify when an agent asks a question.**

Slice 2b (the manager loop) is large: a recurring tick, Start/Stop, concurrency, reaping, idle-backoff, the **manager LLM** (decompose requirements → stories + intelligent routing), plus the two asks above. We decompose it:

- **2b-1 — autonomous run loop + question notifications** *(this spec)*: Start/Stop drives a tick that auto-runs `pending` stories **one at a time**, plus a structured **question → Needs-input → notify → answer → re-run** flow. No manager LLM, no concurrency.
- **2b-2 — manager LLM** (later): a `claude` manager that decomposes requirements into stories and does intelligent multi-repo routing ("hive decides what + where" in full).

This spec is **2b-1 only.**

## Key decisions (settled in brainstorming)

- **Serial auto-advance, not concurrency.** The loop runs one worker at a time; when the runner is free and a `pending` story exists, it starts the next. Keeps the proven single-run runner (`isBusy` guard) intact — minimal rework, low risk. Concurrency is a later slice.
- **Only `pending` stories; never auto-retry.** The loop picks `pending` stories in creation order. A run that ends `blocked` / `review` / `needs-input` is **left for the human** — the loop never re-runs it (no token-burning retry loops). It just advances to the next `pending` story.
- **Questions via a structured marker → pause + notify.** The worker is told: if blocked on a decision it can't make, write the question to `.hive/state/questions/<storyId>.md` and **stop** (don't guess). The IDE detects the file on run exit, moves the story to a new **`needs-input`** state, and fires a **native desktop notification** + a Dock surface. The operator answers in the IDE; the answer is appended to the story and the story flips back to `pending`, so the loop re-runs it with the prior question + answer in context.
- **Loop control lives in the Dock "Run" tab** — a Start/Stop toggle + status (Running/Idle, "Working on: <story>").
- **Routing unchanged from 2c** — unassigned story → project's first repo. Intelligent routing is 2b-2.
- **Loop targets the active workspace.** It reads the active project's connected workspace each tick. Switching projects re-targets it; stopping is manual. (Recommend stopping before switching projects; acceptable for this slice.)

## Architecture

Approach **A — interval-tick supervisor** (chosen): a main-process module polls the file-state snapshot each tick and drives the existing `runStory`. Rejected: (B) event-driven off the watcher — sequencing "run next when current finishes" is fiddly; (C) in-memory queue — redundant with the authoritative file state.

### 1. Worker prompt — `src/main/hive/run/prompt.ts`

Extend the shared `COMMON` system-prompt text with a question rule:

> If you are blocked on a decision you cannot reasonably make yourself (ambiguous requirements, a destructive choice, missing context), do NOT guess: write a single clear question to `.hive/state/questions/<storyId>.md` (relative to the workspace root, which is the parent of your worktree's repo) and stop without committing. Otherwise, complete the work and commit.

The worker is given its `storyId` and the **absolute workspace path** in the task prompt (the worktree cwd is the repo checkout, but `.hive/state/questions/` lives in the workspace *outside* the worktree). The question file is the **one explicit exception** to `COMMON`'s "don't touch files outside this worktree" rule — the prompt calls this out so the two instructions don't contradict. The task prompt gives the exact absolute path to write: `<workspace>/.hive/state/questions/<storyId>.md`.

### 2. New story state — `src/types/hive.ts`

- Add `'needs-input'` to `StoryStatus`.
- Add a `RunOutcome` member `'needs-input'` (the run-finish outcome union used by `nextStoryStatus`).
- Add loop status + question event payload types:

```ts
export interface HiveLoopStatus {
  running: boolean;
  /** Story id currently being worked, or null when idle. */
  currentStory: string | null;
}

export interface HiveQuestion {
  storyId: string;
  question: string;
}
```

`nextStoryStatus('needs-input') → 'needs-input'`. The slice-1 board adapter (`hiveView.ts`) maps `needs-input` into a visible "Needs input" group (alongside the existing columns).

### 3. Question detection — folded into the run finish

In the run orchestration (`handlers.ts` `runStory` onExit ladder), after the child exits, **check for `<workspace>/.hive/state/questions/<storyId>.md` first**:
- present → outcome `needs-input` (read its contents as the question text; emit a `question` event + trigger a notification), story → `needs-input`.
- else exit 0 + commit → `success` → `review`; exit 0 no commit → `no-commit` → `blocked`; non-zero → `failure` → `blocked`; signal → `interrupted` → `pending`.

`writeRunFinish` learns the `needs-input` outcome (sets story `needs-input`, agent `exited` with note "awaiting answer", appends a `needs-input` event).

### 4. Answer flow — `src/main/hive/run/question.ts` (pure + writer)

```ts
/** Read the pending question for a story, or null. */
export async function readQuestion(workspacePath: string, storyId: string): Promise<string | null>

/** Apply an answer: append a Q&A block to the story body, delete the question
 *  file, set the story back to `pending`, append an `answered` event. The loop
 *  then re-runs the story with the Q&A now in its body (→ in the task prompt). */
export async function answerQuestion(workspacePath: string, storyId: string, answer: string, now: string): Promise<void>
```

Appending the Q&A to the **story body** means the next run's task prompt (which renders the body) automatically carries the context — no prompt-builder change. The question file is deleted so it isn't re-detected.

### 5. The supervisor — `src/main/hive/run/supervisor.ts`

```ts
export interface SupervisorDeps {
  /** Pending story ids in run order, for the active workspace. */
  getPendingStoryIds: () => Promise<string[]>;
  isRunnerBusy: () => boolean;
  runStory: (storyId: string) => Promise<void>;   // existing orchestration
  onStatus: (s: HiveLoopStatus) => void;           // push to renderer
  /** Schedule the next tick after `ms`. Injected for tests (no real timers). */
  schedule: (ms: number, fn: () => void) => void;
}

export interface Supervisor {
  start(): void;
  stop(): void;
  status(): HiveLoopStatus;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor
```

Tick logic (the testable core): if not running → do nothing. If runner busy → reschedule at the **active** interval. Else fetch pending ids; if one exists → set `currentStory`, push status, `void runStory(id)` (fire-and-forget; the next tick sees the runner busy then free), reschedule active. If none → `currentStory = null`, push idle status, reschedule at the **idle** interval (backoff). `ACTIVE_TICK_MS ≈ 1500`, `IDLE_TICK_MS ≈ 8000`. `stop()` flips running off and pushes a stopped status; an in-flight `runStory` is allowed to finish (not killed).

### 6. Notifications — `src/main/hive/run/notify.ts`

A thin wrapper over Electron's `Notification` (main process). Fired on `needs-input` (title "Hive needs input", body = story title + the question, click focuses the window + the Dock). Optionally on `blocked`. Guarded: no-ops if `Notification.isSupported()` is false. Injected/abstracted so the orchestration is testable without Electron.

### 7. IPC + main wiring — `handlers.ts` + `index.ts`

New channels:

| Channel | Dir | Payload |
|---|---|---|
| `ipc:hive:loop:start` | r→m invoke | `{}` → `void` |
| `ipc:hive:loop:stop` | r→m invoke | `{}` → `void` |
| `ipc:hive:loop:status` | r→m invoke | `{}` → `HiveLoopStatus` |
| `ipc:hive:answer-question` | r→m invoke | `{ storyId, answer }` → `void` |
| `event:hive:loop:status` | m→r push | `HiveLoopStatus` |

`index.ts` builds the supervisor with real deps: `getPendingStoryIds` reads the active workspace's `state/stories/*.md`, parses, filters `status === 'pending'`, sorts by `createdAt`; `isRunnerBusy` = the existing `hiveRunner.isBusy()`; `runStory` = the existing run orchestration; `onStatus` pushes over the window; `schedule` = `setTimeout` (unref'd). Question detection + notification wire into the existing run-finish path. The supervisor is stopped + the timer cleared on quit.

### 8. Preload + renderer

- Preload: `window.hive.loop.{ start, stop, status, onStatus }` and `window.hive.story.answer(storyId, answer)`, mirroring the existing `run`/`workspace`/`story` bridges.
- Dock **Run tab**: a **Start/Stop** toggle + status line ("Running · Working on `<id>`" / "Idle" / "Stopped"), fed by `loop.onStatus` (a small `useHiveLoop` hook like `useHiveRun`).
- **Needs-input surface**: stories in `needs-input` render in a "Needs input" group on the board (and/or the Run tab) showing the question text + an answer textarea + a "Send answer" button → `window.hive.story.answer(storyId, answer)`. The watcher then flips the card back to pending and the loop re-runs it.

## Data flow

```
Start (Dock) → ipc:hive:loop:start → supervisor.start()
  tick: runner free + a pending story?  → runStory(id)   (serial)
        worker runs in worktree …
          → wrote .hive/state/questions/<id>.md ?  → outcome needs-input
              → story → needs-input, `question` event, desktop Notification
          → else success/blocked/etc (unchanged from 2a)
  next tick advances to the next pending story; idle → backoff

Answer (Dock) → ipc:hive:answer-question {id, answer}
  → answerQuestion: append Q&A to story body, delete question file,
    story → pending, `answered` event
  → loop re-runs the story (Q&A now in the task prompt)

Stop (Dock) → supervisor.stop()  (in-flight run finishes; no new runs)
```

The slice-1 watcher renders every board/log change; 2b-1 only adds the left column (the tick + question/answer writes + the loop-status push).

## Error handling

- **`getPendingStoryIds` read failure** (workspace gone) → return `[]`; the loop idles, doesn't crash.
- **`runStory` rejects** (e.g. spawn ENOENT) → already terminal per 2a (story → blocked); the supervisor's fire-and-forget `void runStory(id).catch(log)` swallows it and the next tick advances.
- **No workspace connected** → `getPendingStoryIds` returns `[]`; loop idles. (Start is only offered when connected.)
- **Malformed question file** (empty) → treat as a question with empty text; still `needs-input` so the human looks. Never throws.
- **Notification unsupported** → `notify` no-ops.
- **Answer with no question file** (race: already answered) → `answerQuestion` is best-effort; if the file is gone it just ensures status `pending` and logs.
- **Stop during an in-flight run** → the run completes and writes its state; no new run starts. Quit clears the timer and reaps the active child (existing 2a behavior).

## Testing

- **supervisor.ts (Vitest, injected `schedule`):** tick starts a pending story when free; skips when busy; idles + backs off when none; `stop()` halts new starts; status pushes on each transition. No real timers.
- **question.ts (Vitest, temp dir):** `readQuestion` returns contents / null; `answerQuestion` appends a Q&A block to the body, deletes the file, sets `pending`, appends an event; round-trips through `parseStory`.
- **outcome ladder (Vitest):** question-file-present → `needs-input` takes precedence over commit/no-commit; `nextStoryStatus('needs-input') → 'needs-input'`; `writeRunFinish` writes the `needs-input` story + event.
- **prompt.ts (Vitest):** `COMMON` includes the question-file rule; the task prompt exposes the storyId + workspace path.
- **notify (Vitest):** fires with the right title/body on `needs-input`; no-ops when unsupported (injected).
- **hiveView.ts (Vitest):** `needs-input` maps into the board "Needs input" group.
- **Manual:** Start the loop with two pending stories → both run serially → board advances without clicking Run. Author a story whose description forces a question ("ask me which DB to use before proceeding") → it goes Needs-input, a desktop notification fires, the question shows in the Dock → answer it → it re-runs and completes. Stop mid-loop → the current run finishes, no new run starts.

## Forward compatibility (full orchestration)

This slice is deliberately a thin loop over the file-state-as-source-of-truth
model so the full orchestrator remains reachable without rework:

- **Manager LLM (2b-2)** plugs in as the producer of `pending` stories
  (decompose requirements → stories). The loop already *consumes* `pending`
  stories, so the manager slots in with no loop change.
- **Concurrency** is an isolated change to the runner (1-active → N-active) plus
  the supervisor's "run next when free" → "run up to N". The serial choice here
  does not block it.
- **Routing** flows through `resolveRepoForStory(story.team, …)`; the manager
  just sets `team` intelligently and the loop/run honor it unchanged.
- **Acceptance-criteria verification (future, slice 4)** — a `/goal`-style check
  that runs after a worker commits, verifying the work against the story's
  `acceptanceCriteria` before the story may be merged (a QA-role agent or a
  dedicated verifier). The criteria are already captured on every story; this
  slice's `review` state is the natural hand-off point into that QA step.

## Out of scope (later slices)

- The **manager LLM** — decomposing requirements into stories; intelligent multi-repo routing (2b-2).
- Concurrency (> 1 worker), per-story retry policies.
- Requirements-authoring UI.
- QA / merge / PR surfacing + actions (slice 4); semantic memory.
- A true interactive pause/resume of a running worker (we use the write-question-and-stop model instead).
