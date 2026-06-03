# Hive native orchestration — Slice 1: state model + live session viewer

**Date:** 2026-06-03
**Status:** Approved, pending implementation plan
**Track:** Native hive orchestration in the IDE (slice 1 of 4)

## Context

The IDE's agent surfaces — the Dock's Run/Stories/Chat, the bottom `manager.log`,
and the PRs view — currently render **seed mock data** behind "Hive not
connected" ribbons (`src/renderer/src/data/seed.ts`). They model a
hungry-ghost-hive fleet: a manager orchestrator decomposes requirements into
stories, assigns role agents (tech-lead / senior / intermediate / junior / qa)
that each run a Claude Code subprocess in a git worktree, and merges their work.

We are building that orchestration **natively into the IDE** rather than wrapping
the existing `hive` Go binary. This is feasible because hive's *intelligence*
lives in reusable Claude skills (`manager.md`, `tech-lead.md`, the role skills)
plus its state store — the Go binary is largely a **supervisor harness** (spawn
`claude --print` subprocesses, manage git worktrees, stream/rotate logs,
idle-backoff, reap by `kill -0`, run the test command, merge). The IDE already
owns the primitives that harness needs: subprocess spawning (node-pty), a git
runner, file watching, and the terminal.

### Decomposition (the whole track)

Each slice is its own spec → plan → build:

1. **State model + live session viewer** *(this spec)* — define the native
   `.hive/state/` file schema, read it, and wire the existing panels to it.
   Read-only; no process supervision.
2. **Native supervisor (run loop)** — reimplement the watchdog tick in the IDE
   main process: spawn the manager `claude --print` each tick, reap, stream
   logs, idle-backoff, start/stop. Auto-create the workspace and inject the
   project's repos as teams.
3. **Requirements & standalone agents** — add-requirement UI; the separate
   "spin up a one-off Claude agent for a small task" track.
4. **Native manager logic + QA/merge + PRs + (optional) semantic memory.**

This spec is **slice 1 only**.

## Key decisions (with rationale)

- **Native, not a wrapper of the `hive` binary.** Operator choice. The IDE
  becomes the orchestrator over time; the Claude role skills are reused as-is.
- **Files are the single source of truth for orchestration state.** State lives
  as `.hive/state/**` markdown-with-frontmatter files plus an append-only
  `events.ndjson`. mempalace (the Python `mempalace_gateway` MCP over ChromaDB)
  is **removed from the spine**. Reasons: it is cross-language/out-of-process
  with a hardcoded venv path (fights an Electron/TS app); you do not need
  semantic search to know a story is `pending`; and the IDE just gained a file
  watcher, so a file-backed store makes the live viewer fall out for free
  (an agent writes `stories/AUTH-3.md` → watcher fires → board updates).
  Semantic memory is a *separate* concern, deferred to slice 4 as an optional
  enrichment, never the spine.
- **Workspace ↔ project mapping: dedicated workspace dir, remembered per
  project.** A hive workspace is a directory holding `.hive/` plus the team repo
  clones under `repos/`. The IDE stores a `hiveWorkspacePath` on the project.
  In this slice the user *points at* an existing workspace ("Connect hive
  workspace…"); auto-creation + repo injection is slice 2.

## Scope

**In scope (slice 1):**

- The `.hive/state/` file schema and matching TS types.
- A per-project `hiveWorkspacePath`, persisted, with a "Connect hive workspace…"
  picker that validates `<dir>/.hive/` exists.
- A main-process reader that parses the state files, watches them, tails
  `events.ndjson`, and streams a `HiveSnapshot` + log deltas to the renderer.
- Wiring the existing `Dock` (roster + Stories board) and `BottomPanel`
  (manager-log tab) to that live state, replacing the seed mocks, with
  no-workspace / idle / live states.

**Out of scope (later slices):** workspace auto-creation + repo injection;
spawning manager/agent subprocesses; the run loop / start-stop; add-requirement
and requirements UI; QA / merge / PRs; native manager decision logic; semantic
memory; the Dock Chat tab (stays mock this slice).

## Architecture

Four small units, each independently testable.

### 1. State schema — `src/types/hive.ts`

Shared TS types describing both the in-memory model and the on-disk contract.
The on-disk fields mirror hive's drawer model so the format stays compatible
with the supervisor we build in slice 2.

```ts
export type HiveRole =
  | 'manager' | 'tech-lead' | 'senior' | 'intermediate' | 'junior' | 'qa'

export type StoryStatus =
  | 'pending' | 'assigned' | 'in-progress' | 'review'
  | 'merged' | 'blocked' | 'abandoned'

export type RequirementStatus =
  | 'pending' | 'decomposed' | 'in-flight' | 'complete' | 'blocked'

export type AgentStatus = 'live' | 'exited'

export interface HiveStory {
  id: string                     // = filename stem
  title: string
  status: StoryStatus
  role: HiveRole
  points: number                 // Fibonacci 1/2/3/5/8/13
  team: string                   // team (repo) name
  assignedTo?: string            // agent id
  featureBranch?: string
  dependsOn: string[]            // story ids
  acceptanceCriteria: string[]
  parentRequirement?: string     // requirement id
  prUrl?: string
  createdAt: string              // ISO 8601
  updatedAt: string
  mergedAt?: string
  body: string                   // markdown after frontmatter
}

export interface HiveAgent {
  id: string                     // = filename stem
  role: HiveRole
  status: AgentStatus
  team: string
  currentStory?: string          // story id
  worktree?: string              // path relative to workspace
  pid?: number
  startedAt: string
  endedAt?: string
  note?: string                  // human-readable roster line
}

export interface HiveRequirement {
  id: string                     // = filename stem
  title: string
  status: RequirementStatus
  featureBranch?: string
  decomposedInto: string[]       // story ids
  createdAt: string
  updatedAt: string
  body: string
}

export type HiveEventLevel = 'info' | 'ok' | 'warn' | 'pr'

export interface HiveEvent {
  ts: string                     // ISO 8601
  actor: string                  // 'manager' | role | agent id
  event: string
  detail: string
  level: HiveEventLevel
}

/** The aggregated state the renderer renders. */
export interface HiveSnapshot {
  requirements: HiveRequirement[]
  stories: HiveStory[]
  agents: HiveAgent[]
}

/** Connection status of the active project's hive workspace. */
export type HiveConnection =
  | { state: 'no-workspace' }                 // no hiveWorkspacePath set
  | { state: 'not-found'; path: string }      // path set but .hive/ missing
  | { state: 'connected'; path: string }      // .hive/ present and readable
```

### 2. Workspace locator + project field

- Add `hiveWorkspacePath?: string` to `Project` (`src/types/workspace.ts`) and
  to the persisted `ProjectSession` shape, threaded through the existing
  `electron-store` save/migrate path. Migration: absent field → `undefined`
  (no behaviour change for existing projects).
- A new IPC handler `ipc:hive:connect-workspace` opens a directory picker
  (Electron `dialog.showOpenDialog`, `properties: ['openDirectory']`), validates
  that `<dir>/.hive/` exists, and on success stores the path on the active
  project via the store. Validation reuses `validatePath`.
- A `ipc:hive:disconnect-workspace` clears the field.

### 3. Hive state reader — `src/main/hive/reader.ts`

Owns one workspace at a time (the active project's). Responsibilities:

- **Parse** `.hive/state/{requirements,stories,agents}/*.md`: split frontmatter
  with the existing `yaml` dependency, map to `HiveRequirement` / `HiveStory` /
  `HiveAgent` via pure functions in `src/main/hive/parse.ts`. The `id` is the
  filename stem.
- **Aggregate** into a `HiveSnapshot` (pure, in `parse.ts`).
- **Tail** `.hive/events.ndjson`: parse each new line as a `HiveEvent`; keep a
  bounded in-memory tail (last 500 events) for late subscribers.
- **Watch** `.hive/state/` and `.hive/events.ndjson` with chokidar (same adapter
  shape as `src/main/project/handlers.ts`), debounced 100 ms; on change,
  re-read and push the new `HiveSnapshot` (and any new events) to the renderer.
- **Lifecycle**: `start(workspacePath)` (idempotent; re-points the watcher),
  `stop()` (closes the watcher). Re-pointed when the active project or its
  `hiveWorkspacePath` changes.

IPC surface (renderer ← main):

| Channel | Direction | Payload |
|---|---|---|
| `ipc:hive:connect-workspace` | renderer→main (invoke) | → `HiveConnection` |
| `ipc:hive:disconnect-workspace` | renderer→main (invoke) | → `HiveConnection` |
| `ipc:hive:get-snapshot` | renderer→main (invoke) | → `{ connection, snapshot, events }` |
| `event:hive:snapshot` | main→renderer (push) | `HiveSnapshot` |
| `event:hive:events` | main→renderer (push) | `HiveEvent[]` (deltas) |
| `event:hive:connection` | main→renderer (push) | `HiveConnection` |

The preload exposes `window.hive.orchestration.{connectWorkspace, disconnectWorkspace,
getSnapshot, onSnapshot, onEvents, onConnection}` mirroring the existing bridge style.

### 4. Viewer wiring (renderer)

- A `hive` store slice (`src/renderer/src/store/hiveStore.ts` or a slice of the
  workspace store) holding `{ connection, snapshot, events }`, fed by the three
  `event:hive:*` subscriptions, established once in the app shell (mirroring the
  `useProjectWatchers` pattern). Re-points when the active project changes.
- A pure adapter `src/renderer/src/lib/hiveView.ts` mapping the native model to
  the existing panel props:
  - **Roster** (Dock Run tab): `HiveAgent[]` → the Dock's agent rows. `note`
    is shown verbatim; status maps live→running, exited→done.
  - **Board** (Dock Stories tab): `HiveStory[]` grouped into columns
    **pending** (`pending`+`assigned`), **in-progress** (`in-progress`),
    **review** (`review`), **done** (`merged`). `blocked`/`abandoned` render in
    pending with a state marker.
  - **Manager log** (BottomPanel): `HiveEvent[]` → `LogLine` (`level`→`cls`,
    `ts`→`t` formatted, `event`+`detail`→`txt`).
- Replace the seed-driven props for these three surfaces; remove the
  "Hive not connected" ribbon on them (the `MockDataRibbon`). The Chat tab and
  PRs view keep their mocks this slice.
- States: `no-workspace` → Dock shows a "Connect a hive workspace…" call to
  action wired to `connectWorkspace`; `not-found` → "Workspace not found" +
  reconnect; `connected` with zero agents/stories → an idle empty state;
  otherwise the live fleet.

## Data flow

```
agent or fixture writes .hive/state/<kind>/<id>.md   (or appends events.ndjson)
  → chokidar (main, debounced 100ms)
  → reader re-parses the changed kind
  → parse.ts builds HiveSnapshot (+ new HiveEvent[])
  → event:hive:snapshot / event:hive:events  IPC
  → hive store
  → hiveView adapter
  → Dock roster/board + BottomPanel manager-log re-render
```

This is the auto-sync watcher pattern (REQ-002 external changes) applied to
state files instead of editor files.

## Error handling

- **Malformed frontmatter / unparseable file:** skip that one entity, `console.warn`
  with the path, and render every other entity. One bad file must never blank
  the board.
- **Unknown/invalid `status` value (not in the union):** coerce to a typed
  fallback — `pending` for stories and requirements, `exited` for agents — and
  `console.warn` with the path and the offending value. The entity is still
  rendered (in its fallback bucket), never dropped.
- **Missing required field** (e.g. a story with no `title`): fall back to the
  filename stem for `title`, warn; treat other missing scalars as their
  type's empty value (`points: 0`, empty arrays).
- **`events.ndjson` line that is not valid JSON:** skip the line, warn, continue.
- **Workspace path set but `.hive/` removed at runtime:** reader emits
  `connection: { state: 'not-found' }`; the viewer shows the reconnect state and
  the watcher idles until reconnected.
- **Reader/watcher failure:** logged and swallowed; never crashes the renderer
  (consistent with the project file watcher).

## Testing

- **`parse.ts` (Vitest, the bulk of the logic):** frontmatter → entity for each
  kind, including missing optional fields, missing required fields (filename-stem
  fallback for `title`), unknown status strings (coerced to the typed fallback
  and warned, per Error handling), and malformed files (skipped, not thrown).
  `HiveSnapshot` aggregation from a fixture directory.
- **`hiveView.ts` (Vitest):** status → board column mapping; agent → roster row;
  `HiveEvent` → `LogLine`. Edge cases: empty snapshot, blocked/abandoned
  placement, unknown role.
- **Manual:** create a `.hive/state/` with fixture `stories/*.md`,
  `agents/*.md`, and an `events.ndjson`; connect via the picker; confirm the
  Dock roster/board and bottom log populate, and that editing a fixture file
  updates the UI live (watcher round-trip).

No new React-rendering tests (the project has no jsdom/RTL); the logic lives in
the pure `parse.ts` / `hiveView.ts` modules, mirroring `externalChange.ts` /
`useProjectWatchers.ts`.

## Out of scope (future slices)

- Workspace auto-creation, `config.yaml` authoring, repo injection (slice 2).
- Spawning manager/agent `claude --print` subprocesses, the watchdog/run loop,
  start-stop controls, idle backoff, reaping (slice 2).
- `add-req` / requirements authoring UI; standalone one-off agents (slice 3).
- QA, merge, PR surfacing and actions; native manager decision logic; semantic
  memory / knowledge-graph recall (slice 4).
- The Dock **Chat** tab and **PRsView** stay mock-driven this slice.
