# Hive native orchestration — Slice 2c: workspace bootstrap + story authoring from the UI

**Date:** 2026-06-08
**Status:** Approved (design), pending implementation plan
**Track:** Native hive orchestration in the IDE (slice 2 of 4 — third sub-slice)

## Context

Slices already shipped:
- **Slice 1** — read-only viewer: parse `.hive/state/**`, tail `events.ndjson`, watch
  both, render the Dock roster / Stories board / manager log.
- **Slice 2a** — run one worker: a **Run** button spawns a `claude` worker in an
  isolated worktree, streams it, reaps it, writes the story's new state.

The gap this slice closes: today you can only *run* a story that already exists,
and the workspace + story files must be created **by hand on disk** (no `.hive/`
bootstrap, no story-authoring UI). The user asked for "this done from the UI to
not have to run scripts, and auto-create a workspace when we create a project."

This is **slice 2c** — UI-driven workspace creation + story authoring. (Slice 2b,
the recurring manager tick/run-loop, is independent and comes later; 2c does not
depend on it.)

## Key decisions (settled in brainstorming)

- **Workspace location: IDE-managed, under app data.** A project's hive workspace
  lives at `<userData>/hive-workspaces/<projectId>/`, holding `.hive/state/**`,
  `.hive/events.ndjson`, and the worktrees. Invisible, never pollutes the user's
  repos. The worker still cuts its worktree from the *project's repo*; only hive
  bookkeeping + worktrees live under app data.
- **Auto-create on project create; "Initialize hive" for existing projects.** A
  brand-new project gets a workspace bound automatically (cheap — just dirs).
  Existing projects with no workspace show an **Initialize hive** action in the
  Dock's `no-workspace` state.
- **Story form captures Title + Description + Role + Acceptance criteria + Team.**
  `Team` is a dropdown of the project's repos (the repos *are* the teams). Status
  defaults to `pending`; timestamps auto; points optional/omitted.
- **A story targets a repo via its `team`.** The project's repos are the teams; a
  story names one. This replaces slice-2a's `repos[0]` assumption: the worker
  resolves its repo from `story.team` (matched to the project repo of that name),
  falling back to the first repo.
- **Story id = title slug, de-duped.** `"Add login form"` → `add-login-form`;
  if a file with that stem exists, append `-2`, `-3`, … The id is the filename
  stem (slice-1 contract).

## Scope

**In scope (2c):**

- Main: `ensureWorkspace(projectId)` — idempotently create
  `<userData>/hive-workspaces/<projectId>/.hive/state/{requirements,stories,agents}/`
  + an empty `events.ndjson`; return the absolute path.
- Main: `createStory(workspacePath, fields)` — slug + dedupe the id, write
  `state/stories/<id>.md` via slice-2a's `serializeStory`, append a `created`
  event. (The slice-1 watcher renders it — no new board code.)
- Renderer: auto-create + bind the workspace on **project create**; **Initialize
  hive** in the Dock for existing projects; **New story** modal launched from the
  board.
- Slice-2a touch: resolve the worker's repo from `story.team` (team→repo), not
  `repos[0]`.

**Out of scope (later slices):** the recurring manager tick / run loop / start-stop
(2b); the manager's own decompose/assign LLM (2b); multi-agent concurrency (2b);
requirements-authoring UI; editing/deleting an existing story from the UI (this
slice only *creates*); QA / merge / PR surfacing (slice 4); semantic memory.

## Architecture

Small units, each independently testable. New main code under `src/main/hive/run/`
(workspace + story authoring sit next to the run code that consumes them).

### 1. Workspace bootstrap — `src/main/hive/run/workspace.ts`

```ts
/** Absolute path of a project's IDE-managed hive workspace. */
export function workspaceDirFor(userDataPath: string, projectId: string): string
  // → join(userDataPath, 'hive-workspaces', projectId)

/** Idempotently create the .hive/ tree; return the workspace dir. Safe to
 *  call repeatedly. */
export async function ensureWorkspace(userDataPath: string, projectId: string): Promise<string>
```

`ensureWorkspace` `mkdir -p`s `state/requirements`, `state/stories`, `state/agents`
under `<dir>/.hive/`, and creates an empty `events.ndjson` if absent (never
truncates an existing one). Pure-ish: takes `userDataPath` so it's testable
against a temp dir; the IPC layer passes `app.getPath('userData')`.

### 2. Story authoring — `src/main/hive/run/story.ts`

```ts
/** Fields the New-story form collects. */
export interface NewStoryFields {
  title: string
  body: string            // description / markdown
  role: HiveRole
  team: string            // repo name
  acceptanceCriteria: string[]
}

/** Pure: title → filename-stem slug. "Add login form" → "add-login-form". */
export function slugify(title: string): string

/** Pure: given a base slug and the set of existing story ids, return a unique
 *  id (append -2/-3/… on collision). */
export function uniqueStoryId(base: string, existing: ReadonlySet<string>): string

/** Build a HiveStory from form fields + a resolved id + timestamp (pure). */
export function buildStory(fields: NewStoryFields, id: string, now: string): HiveStory
```

`buildStory` sets `status: 'pending'`, `assignedTo`/`featureBranch`/`prUrl`
absent, `points: 0`, `createdAt = updatedAt = now`, `dependsOn: []`. Reuses the
`HiveStory` shape from `src/types/hive.ts`.

### 3. Story writer — `src/main/hive/run/story-writer.ts` (or fold into `story.ts`)

```ts
/** Resolve a unique id, write state/stories/<id>.md via serializeStory, append
 *  a `created` event. Returns the new story id. */
export async function createStory(workspacePath: string, fields: NewStoryFields, now: string): Promise<string>
```

Reads the existing `state/stories/` filenames to seed `uniqueStoryId`, writes
the file with slice-2a's `serializeStory`, appends one `events.ndjson` line
(`event: 'created'`, `actor: 'user'`, `detail: id`, `level: 'info'`). Best-effort
+ throws on fs failure (the IPC handler surfaces it).

### 4. IPC + main wiring — extend `src/main/hive/run/handlers.ts` (or a sibling)

New channels:

| Channel | Dir | Payload |
|---|---|---|
| `ipc:hive:ensure-workspace` | r→m invoke | `{ projectId }` → `{ workspacePath }` |
| `ipc:hive:create-story` | r→m invoke | `{ workspacePath, fields }` → `{ storyId }` |

`ensure-workspace` calls `ensureWorkspace(app.getPath('userData'), projectId)`
then points the reader (`hiveReader.setWorkspace(path)`) so the board goes live.
`create-story` calls `createStory(...)`; the slice-1 watcher then emits the
updated snapshot — no extra push needed.

**Team→repo in the run path:** change `activeRepoPath` (slice-2a wiring in
`index.ts`) into a `resolveRepoForStory(story)` that matches `story.team` against
the active project's repo names, falling back to `repos[0]`. Wire it into the
existing `RunDeps.getRepoPath` (make `getRepoPath` story-aware, or resolve the
repo inside `runStory` from the already-fetched story — the latter is cleaner:
`runStory` already has the story, so pass its `team` to a repo resolver).

### 5. Preload — extend `window.hive` bridge

Add to `src/preload/{api,index}.ts`, mirroring the existing `run`/`orchestration`
style:
- `window.hive.workspace.ensure(projectId): Promise<{ workspacePath }>`
- `window.hive.story.create(workspacePath, fields): Promise<{ storyId }>`

### 6. Renderer wiring

- **Project create (`NewProjectModal`)** — after `createProject` + the repos are
  added, call `window.hive.workspace.ensure(project.id)`, then
  `setHiveWorkspacePath(path)` and point the reader (reuse the existing
  `onConnectHive`/`setWorkspace` path). New projects open with a live (empty)
  board.
- **Initialize hive (Dock `no-workspace` state)** — replace/augment the existing
  "Connect…" affordance with an **Initialize hive** button that runs the same
  `ensure` + bind flow for the active project. (Keep "Connect…" too, for pointing
  at a pre-existing external workspace.)
- **New story modal** — a **+ New story** button on the board header opens a modal
  with Title, Description (textarea), Role (select over `HiveRole`), Team (select
  over the active project's repo names), and an add/remove **Acceptance criteria**
  list. Submit → `window.hive.story.create(workspacePath, fields)` → the watcher
  makes the card appear (Pending). Validation: title required; ≥0 criteria.
- **Boot** — existing projects with a saved `hiveWorkspacePath` already reconnect
  via slice-1; projects created this slice persist their `hiveWorkspacePath` the
  same way, so they reconnect on relaunch.

## Data flow

```
New Project (modal)
  → createProject + addRepoToProject (existing)
  → window.hive.workspace.ensure(projectId)
  → ipc:hive:ensure-workspace → ensureWorkspace(userData, projectId)  (mkdir tree)
  → setHiveWorkspacePath(path) + reader.setWorkspace(path)
  → board live (empty)

New Story (modal)
  → window.hive.story.create(workspacePath, fields)
  → ipc:hive:create-story → createStory → write stories/<id>.md + created event
  → slice-1 chokidar watcher fires → snapshot push → board shows the card (Pending)

Run (slice 2a, now team-aware)
  → runStory resolves repo from story.team (→ project repo of that name, else repos[0])
  → worktree cut from that repo → claude worker → … (unchanged from 2a)
```

## Error handling

- **`ensureWorkspace` fs failure** (permissions, disk) → IPC rejects; the modal /
  Initialize button surfaces the message; project creation still succeeds (the
  workspace can be initialized later from the Dock).
- **`createStory` slug collision** → handled by `uniqueStoryId` (deterministic
  suffix); never overwrites an existing story file.
- **Empty/whitespace title** → form blocks submit (client-side); `slugify` also
  guards (a blank slug falls back to `story` + dedupe suffix).
- **`team` naming a repo that no longer exists** at run time → `resolveRepoForStory`
  falls back to `repos[0]` (slice-2a behavior), so a stale team never wedges a run.
- **Workspace dir already exists** → `ensureWorkspace` is idempotent (mkdir
  recursive, events.ndjson only-if-absent); re-init is a no-op.

## Testing

- **`workspace.ts` (Vitest, temp dir):** `workspaceDirFor` path; `ensureWorkspace`
  creates the tree, is idempotent (second call no-ops, doesn't truncate
  events.ndjson).
- **`story.ts` (Vitest, pure):** `slugify` (spaces/case/punctuation/unicode →
  safe stem; blank → fallback); `uniqueStoryId` (no collision → base; collisions
  → -2/-3); `buildStory` round-trips through `parseStory` for the fields it sets.
- **`story-writer`/`createStory` (Vitest, temp dir):** writes the file, appends a
  `created` event, returns a unique id when a same-titled story exists.
- **team→repo resolver (Vitest, pure):** matches by name; falls back to `repos[0]`
  when the team is absent/unknown.
- **Manual:** create a project → board appears live + empty; **+ New story** →
  fill the form → card appears Pending without a manual refresh; **Run** the new
  story → worktree is cut from the *team's* repo; relaunch → the project reconnects
  its workspace and the story persists.

## Out of scope (future slices)

- The recurring manager tick / run loop / start-stop (2b).
- The manager's decompose/assign LLM + multi-agent concurrency (2b).
- Editing or deleting an existing story from the UI (this slice only creates).
- Requirements-authoring UI; QA / merge / PR surfacing/actions (slice 4); semantic
  memory.
