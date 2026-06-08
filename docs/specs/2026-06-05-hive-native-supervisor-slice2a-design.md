# Hive native orchestration — Slice 2a: run one worker agent, end-to-end

**Date:** 2026-06-05
**Status:** Approved (design), pending implementation plan
**Track:** Native hive orchestration in the IDE (slice 2 of 4 — first sub-slice)

## Context

Slice 1 (`docs/specs/2026-06-03-hive-native-state-viewer-design.md`, shipped) made
the IDE a **read-only viewer** of a hive workspace: it parses `.hive/state/**`,
tails `events.ndjson`, watches both with chokidar, and live-renders the Dock
roster / Stories board and the bottom manager-log. Something *else* (the external
`hive` Go binary, or hand-written files) still has to produce that state.

Slice 2 of the track is the **native supervisor** — the IDE becomes the
orchestrator. Slice 2 as originally scoped (workspace auto-create + repo
injection, the manager tick loop, multi-agent concurrency, idle-backoff,
reaping, log streaming, start/stop) is too large for one spec. We decompose it:

- **2a — run one worker agent, end-to-end** *(this spec)*: a manual "Run" on an
  existing story spawns one `claude` worker in an isolated worktree, streams it,
  reaps it, writes the new state. Proves the subprocess harness — the riskiest
  unknown — before any loop or concurrency.
- **2b — manager tick loop**: Start/Stop drives a recurring tick that spawns the
  manager (decompose + assign) and multiple workers with concurrency + idle
  backoff + reaping. (Later spec.)
- **2c — workspace bootstrap**: auto-create `.hive/` + config, inject the
  project's repos as teams. (Later spec.)

This spec is **2a only.**

## Key decisions (settled in brainstorming)

- **Execution = Claude Code CLI subprocesses.** The IDE spawns the `claude`
  binary headless per agent, reusing hive's role behaviour and the user's
  existing `claude` auth. The IDE owns the loop (native orchestration); Claude
  Code is the agent runtime. No wrapping of the `hive` Go binary.
- **Safety = autonomy via isolation.** The worker runs with permission prompts
  bypassed so it can edit, run tests, and commit unattended. The safety boundary
  is the **isolated git worktree** on the story's feature branch — never the
  user's working tree — reviewed by a human before any merge.
- **Worker behaviour = built-in role prompts, workspace override.** The IDE ships
  a minimal built-in system prompt per `HiveRole`; if
  `<workspace>/.hive/skills/<role>.md` exists it overrides the built-in. The
  worker's *task* is the story (title + body + acceptance criteria + context).
  Works out of the box; hive-compatible when real role skills are dropped in.
- **Success requires a commit.** A run succeeds only on **exit 0 AND ≥1 new
  commit** on the feature branch. Exit 0 with no commit → `blocked` ("no changes
  produced"). Prevents a no-op run from marking a story review-ready.
- **Worktree is left in place** after a run, so the user can inspect the diff.
  Cleanup is a later (merge) slice or a manual action.
- **Trigger = a Run/Stop button per story row** on the Dock Stories board.
- **Single run at a time** this slice (a registry guard). Concurrency is 2b.

## Scope

**In scope (2a):**

- Spawn one `claude` worker subprocess for one existing story, headless, in an
  isolated worktree, permissions bypassed.
- Create/track the worktree + feature branch; detect whether a commit landed.
- Assemble role (built-in + override) + task prompts.
- Stream the worker's output live into the existing manager-log surface and to a
  per-run log file.
- On exit, apply the status transition and write `.hive/state/**` +
  `events.ndjson` in the slice-1 format (the slice-1 watcher renders it).
- A Run/Stop control per story row; live run status; single-run guard.
- Reap on Stop and on IDE quit.

**Out of scope (later slices):** the recurring tick / Start-Stop run loop; the
**manager** (decompose/assign) — 2a runs a worker on a story that already
exists; multi-agent concurrency + idle backoff; workspace auto-create + repo
injection; the IDE separately running/enforcing the test command (the worker is
*told* to test via its prompt this slice); QA / merge / PR surfacing; worktree
cleanup automation; model selection UI; per-agent API-key management (the
subprocess inherits the user's `claude` auth/env).

## Architecture

New main-process area `src/main/hive/run/`, four small units plus IPC. Each unit
has one job, a typed interface, and is testable without invoking real `claude`.

### 1. Prompt assembly — `src/main/hive/run/prompt.ts` (pure)

```ts
/** Built-in fallback system prompt per role. */
export const BUILTIN_ROLE_PROMPTS: Record<HiveRole, string>

/** Resolve the role system prompt: workspace override file or built-in. */
export function resolveRolePrompt(
  role: HiveRole,
  workspaceSkill: string | null,   // contents of .hive/skills/<role>.md, or null
): string

/** Build the worker's task prompt from a story. */
export function buildTaskPrompt(story: HiveStory, ctx: {
  repoName: string
  featureBranch: string
}): string
```

`resolveRolePrompt` returns `workspaceSkill ?? BUILTIN_ROLE_PROMPTS[role]`.
`buildTaskPrompt` renders the story id/title/body, a bulleted acceptance-criteria
checklist, the team/branch, and an explicit instruction set: implement the
change in this worktree, run the project's tests, and **commit** when the
acceptance criteria are met. The caller reads the override file off disk (the
pure fn just takes its contents) so this module touches no filesystem.

### 2. Worktree manager — `src/main/hive/run/worktree.ts`

Thin wrapper over the existing git runner (`src/main/git/runner.ts`).

```ts
export interface Worktree { path: string; branch: string; baseSha: string }

/** Create <workspace>/.hive/worktrees/<storyId>/ on `branch` off the repo
 *  default branch. Records baseSha (the branch point) for commit detection. */
export async function createWorktree(opts: {
  repoPath: string; workspacePath: string; storyId: string; branch: string
}): Promise<Worktree>

/** True if the worktree has ≥1 commit beyond baseSha (i.e. work landed). */
export async function hasNewCommit(wt: Worktree): Promise<boolean>

/** Remove the worktree dir (branch retained). Not called by 2a — exported for
 *  later slices + tests. */
export async function removeWorktree(wt: Worktree): Promise<void>
```

`branch` defaults to `story.featureBranch ?? feat/<storyId>`. `createWorktree`
resolves the repo's default branch, `git worktree add -b <branch> <path>
<default>`, and captures `baseSha = git rev-parse <default>`. `hasNewCommit`
runs `git rev-list --count <baseSha>..HEAD` in the worktree (>0 → true).

### 3. Agent runner / supervisor — `src/main/hive/run/runner.ts`

Owns the child process lifecycle. One in-flight run (a module registry holding
the active `RunHandle`; `start` throws if one is already running).

```ts
export interface RunSpec {
  runId: string
  storyId: string
  role: HiveRole
  cwd: string                 // worktree path
  taskPrompt: string
  systemPrompt: string
  env?: NodeJS.ProcessEnv     // defaults to process.env (inherits claude auth)
}

export interface RunnerEvents {
  onLog: (line: string) => void
  onStatus: (s: 'starting' | 'running' | 'exited') => void
  onExit: (result: { code: number | null; signal: NodeJS.Signals | null }) => void
}

export interface Runner {
  start(spec: RunSpec, events: RunnerEvents): void
  stop(runId: string): Promise<void>   // SIGTERM, then SIGKILL after a grace window
  isBusy(): boolean
}

/** Spawn function is injected so tests can supply a fake child. */
export function createRunner(spawnFn?: SpawnFn): Runner
```

Invocation contract (exact flags verified against the installed `claude --help`
during implementation): headless print mode with the role as an appended system
prompt, permissions bypassed, and **structured streaming output** parsed into
log lines, e.g.

```
claude -p <taskPrompt>
  --append-system-prompt <systemPrompt>
  --dangerously-skip-permissions
  --output-format stream-json --verbose
```

run with `cwd = worktree`, `env` inherited. The runner reads stdout as NDJSON,
maps each event to a log line via a small **pure parser** (`parseClaudeStreamLine`
in this module or a sibling) — `assistant` text + `tool_use` name/input →
human-readable lines; the final `result` event carries the outcome. stderr lines
are logged verbatim. On child `exit`, emit `onExit`.

### 4. State writer — `src/main/hive/run/state.ts`

Bridges a finished run back to the slice-1 file format. Pure transition +
serialization, plus a thin writer.

```ts
/** Pure: the new story status from a run outcome. */
export function nextStoryStatus(outcome:
  | { kind: 'success' }                    // exit 0 + commit  → 'review'
  | { kind: 'no-commit' }                  // exit 0, no commit → 'blocked'
  | { kind: 'failure' }                    // non-zero/crash    → 'blocked'
  | { kind: 'interrupted' }                // stopped / quit    → 'pending'
): StoryStatus

/** Pure: serialize a story / agent back to frontmatter markdown. */
export function serializeStory(story: HiveStory): string
export function serializeAgent(agent: HiveAgent): string
export function eventLine(ev: HiveEvent): string   // one events.ndjson line

/** Writer: apply a run's start/finish to .hive/state + events.ndjson. */
export async function writeRunStart(...): Promise<void>
export async function writeRunFinish(...): Promise<void>
```

`writeRunStart`: set story → `in-progress`, `assignedTo = runId`,
`featureBranch`, `updatedAt`; write `agents/<runId>.md` (live, currentStory,
worktree, pid); append `event: started`. `writeRunFinish`: set story status per
`nextStoryStatus`, `updatedAt` (and `prUrl`/`mergedAt` untouched — later slices);
set agent → `exited`, `endedAt`, `note`; append `event: finished | failed`. All
writes reuse the slice-1 parse module's format so the watcher round-trips them.

### 5. IPC + orchestration glue — `src/main/hive/run/handlers.ts`

Wires the renderer to the units and owns the per-run orchestration sequence
(create worktree → writeRunStart → runner.start → on exit: hasNewCommit →
writeRunFinish). Registers:

| Channel | Dir | Payload |
|---|---|---|
| `ipc:hive:run:start` | r→m invoke | `{ storyId }` → `{ runId }` (throws if busy / no workspace) |
| `ipc:hive:run:stop`  | r→m invoke | `{ runId }` → `void` |
| `event:hive:run:log` | m→r push | `{ runId, line }` |
| `event:hive:run:status` | m→r push | `{ runId, storyId, status }` |

Story/roster/board changes themselves flow through the **existing slice-1**
`event:hive:snapshot` / `event:hive:events` push (the runner wrote the files).
The preload exposes `window.hive.run.{ start, stop, onLog, onStatus }` mirroring
the existing bridge style.

### 6. Renderer — Run control + live status

- A **Run/Stop** button on each Dock Stories-board story row. Run calls
  `window.hive.run.start(storyId)`; while a run is active the control shows Stop
  and every other row's Run is disabled (single-run guard, also enforced
  main-side). Bound to the active project's connected workspace; hidden in the
  `no-workspace` / `not-found` states (reuses slice-1 connection state).
- A small **run store slice** (or extension of the slice-1 hive store) holds
  `{ activeRun: { runId, storyId, status } | null }` fed by `event:hive:run:status`,
  and appends `event:hive:run:log` lines into the **existing manager-log surface**
  (so live agent output shows where slice-1 already renders the log). No new view.
- Per-run log file `<workspace>/.hive/logs/<runId>.log` is also written main-side
  for after-the-fact inspection.

## Data flow

```
user clicks Run on story S
  → ipc:hive:run:start { storyId: S }
  → handlers: createWorktree(repo, ws, S, feat/S)         (git worktree add)
            → writeRunStart  (story→in-progress, agent live, event started)   ─┐
            → runner.start(claude -p … --dangerously-skip-permissions, cwd=wt) │ slice-1
  → child stdout (stream-json) → parse → event:hive:run:log + logs/<runId>.log │ watcher
  → child exit(code)                                                          │ renders
      → hasNewCommit(wt)?                                                      │ board/
      → outcome = success | no-commit | failure                              │ roster/
      → writeRunFinish (story→review|blocked, agent exited, event finished) ──┘ log
  → event:hive:run:status exited
```

The right column is unchanged from slice 1: writing the state files drives the
board/roster/log. 2a only adds the left column (spawn + reap + write).

## Error handling

- **`claude` binary not found / spawn ENOENT** → `event:hive:run:status` =
  `exited` with an error log line; write a `failed` event; story stays as it was
  (no false `in-progress`); the Run control re-enables. (Detect by attempting the
  worktree+start sequence; if spawn fails, roll the story back to its prior
  status.)
- **Worktree create fails** (path exists, repo dirty, branch exists) → abort
  before any state mutation; surface the git error to the renderer; story
  unchanged.
- **Subprocess non-zero exit / crash** → treated as `failure` → story `blocked`,
  agent `exited` (warn), `failed` event.
- **Stop pressed** → SIGTERM, then SIGKILL after a grace window → `interrupted`
  → story back to `pending`, agent `exited` ("stopped"); worktree left.
- **IDE quit mid-run** → `before-quit` hook SIGTERMs the child and best-effort
  marks the agent `exited` ("interrupted"); worktree left for inspection.
- **State-file write failure** → logged, swallowed; never crashes main; the
  in-memory run still completes and the log is preserved.
- **Malformed `stream-json` line** → skipped, logged; the run continues (mirrors
  slice-1's bad-line tolerance).

## Testing

- **`prompt.ts` (Vitest, pure):** override-vs-builtin resolution per role;
  task-prompt rendering (acceptance-criteria checklist, branch/team, the
  commit/test instruction); unknown role falls back safely.
- **`worktree.ts` (Vitest):** git command construction for create / hasNewCommit
  / remove with a mocked runner; `hasNewCommit` true/false on count >0 / 0.
- **`runner.ts` (Vitest, injected fake spawn):** lifecycle start→`running`→log
  deltas→exit→`exited`; `isBusy` guard rejects a second `start`; `stop`
  escalates SIGTERM→SIGKILL; the stream-json **parser** maps assistant/tool_use/
  result events to log lines and tolerates malformed lines.
- **`state.ts` (Vitest, pure):** `nextStoryStatus` for all four outcomes;
  `serializeStory`/`serializeAgent` round-trip through the slice-1 parser
  (parse(serialize(x)) === x for the fields 2a writes); `eventLine` shape.
- **`handlers.ts`:** the orchestration sequence with worktree + runner + writer
  all faked — assert the order (worktree → start → start-write; exit+commit →
  review-write) and the busy/rollback paths.
- **Manual end-to-end:** connect a workspace with one `pending` story, click Run,
  watch a real `claude` edit + commit in the worktree, confirm live log streams
  and the board row moves to **review**; run a story the agent can't satisfy →
  confirm **blocked**; press Stop mid-run → confirm the child dies and the story
  returns to **pending**.

## Out of scope (future sub-slices / slices)

- The recurring tick, Start/Stop run loop, idle backoff (2b).
- The **manager** decomposition/assignment LLM (2b) — 2a runs an existing story.
- Multi-agent concurrency + reaping multiple children (2b).
- Workspace auto-create + repo injection (2c).
- IDE-enforced test command, QA, merge, PR surfacing/actions (slice 4).
- Worktree cleanup automation, model selection, per-agent key management.
