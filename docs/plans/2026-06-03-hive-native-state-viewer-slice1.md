# Hive Native State Viewer (Slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a hive workspace's `.hive/state/` files and render a live, read-only fleet view (roster / board / manager-log) in the existing Dock + bottom panel, replacing the seed mocks.

**Architecture:** A main-process reader parses `.hive/state/{requirements,stories,agents}/*.md` (frontmatter via the `yaml` dep) and tails `.hive/events.ndjson`, watches them with chokidar (the existing project-watcher pattern), and pushes a `HiveSnapshot` + log deltas to the renderer over `ipc:hive:*` / `event:hive:*`. The renderer holds the state in a store slice and a pure adapter maps it onto the existing panel props. State source of truth is files only — no mempalace, no DB.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), React 18, Zustand, chokidar v4, `yaml`, Vitest (node env; `mock-fs` for fs-touching tests; pure logic in dedicated modules — no jsdom/RTL).

**Spec:** `docs/specs/2026-06-03-hive-native-state-viewer-design.md`

---

## File Structure

- **Create** `src/types/hive.ts` — shared TS types + the on-disk contract (entities, snapshot, connection, bundle).
- **Create** `src/main/hive/parse.ts` — pure: frontmatter split, entity parsers, event-line parser, `readSnapshot(stateDir)`.
- **Create** `src/main/hive/parse.test.ts` — Vitest for the parsers + `readSnapshot` (mock-fs).
- **Create** `src/main/hive/reader.ts` — singleton reader: owns the active workspace, chokidar watch, events tail, pushes to the renderer.
- **Create** `src/main/hive/handlers.ts` — `ipc:hive:*` registration + channel constants; returns a teardown fn.
- **Modify** `src/main/index.ts` — register hive handlers (inject `getMainWindow`), teardown on quit.
- **Create** `src/renderer/src/lib/hiveView.ts` — pure adapter: `HiveSnapshot`/events → existing `Board` / `Agent[]` / `LogLine[]`.
- **Create** `src/renderer/src/lib/hiveView.test.ts` — Vitest for the adapter.
- **Modify** `src/types/workspace.ts` — add `hiveWorkspacePath?: string` to `Project` + `ProjectSession`.
- **Modify** `src/renderer/src/store/workspaceStore.ts` — `setHiveWorkspacePath` action + thread the field through `setProject` / session build / hydrate.
- **Modify** `src/main/state/migrate.test.ts` — assert the optional field round-trips.
- **Modify** `src/preload/api.ts` — `HiveOrchestrationBridge` on `HiveBridge` + re-export hive types.
- **Modify** `src/preload/index.ts` — implement the bridge + channel constants + subscriptions.
- **Create** `src/renderer/src/lib/useHiveSession.ts` — store slice + the subscription hook (mirrors `useProjectWatchers`).
- **Modify** `src/renderer/src/App.tsx` — call `useHiveSession()`; pass live `roster`/`board`/`log` to `Dock`/`BottomPanel`.
- **Modify** `src/renderer/src/components/AgentDock.tsx` + `BottomPanel.tsx` — connection/idle states; drop `MockDataRibbon` on the wired surfaces.

---

## Task 1: Shared hive types

**Files:**
- Create: `src/types/hive.ts`

- [ ] **Step 1: Write the types**

Create `src/types/hive.ts`:

```ts
/**
 * Native hive-orchestration types — slice 1 (state model + viewer).
 *
 * These describe BOTH the in-memory model the renderer renders AND the
 * on-disk `.hive/state/**` frontmatter contract. Fields mirror hungry-ghost-
 * hive's drawer model so the format stays compatible with the supervisor
 * built in slice 2. Files are the single source of truth — no mempalace.
 *
 * Spec: docs/specs/2026-06-03-hive-native-state-viewer-design.md
 */

export type HiveRole =
  | 'manager'
  | 'tech-lead'
  | 'senior'
  | 'intermediate'
  | 'junior'
  | 'qa';

export type StoryStatus =
  | 'pending'
  | 'assigned'
  | 'in-progress'
  | 'review'
  | 'merged'
  | 'blocked'
  | 'abandoned';

export type RequirementStatus =
  | 'pending'
  | 'decomposed'
  | 'in-flight'
  | 'complete'
  | 'blocked';

export type AgentStatus = 'live' | 'exited';

export interface HiveStory {
  /** = filename stem. */
  id: string;
  title: string;
  status: StoryStatus;
  role: HiveRole;
  points: number;
  team: string;
  assignedTo?: string;
  featureBranch?: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  parentRequirement?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  body: string;
}

export interface HiveAgent {
  id: string;
  role: HiveRole;
  status: AgentStatus;
  team: string;
  currentStory?: string;
  worktree?: string;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  note?: string;
}

export interface HiveRequirement {
  id: string;
  title: string;
  status: RequirementStatus;
  featureBranch?: string;
  decomposedInto: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
}

export type HiveEventLevel = 'info' | 'ok' | 'warn' | 'pr';

export interface HiveEvent {
  ts: string;
  actor: string;
  event: string;
  detail: string;
  level: HiveEventLevel;
}

/** Aggregated state the renderer renders. */
export interface HiveSnapshot {
  requirements: HiveRequirement[];
  stories: HiveStory[];
  agents: HiveAgent[];
}

/** Connection status of the active project's hive workspace. */
export type HiveConnection =
  | { state: 'no-workspace' }
  | { state: 'not-found'; path: string }
  | { state: 'connected'; path: string };

/** Everything a fresh subscriber needs in one round-trip. */
export interface HiveSessionBundle {
  connection: HiveConnection;
  snapshot: HiveSnapshot;
  events: HiveEvent[];
}

/** The valid role strings (for parse-time coercion). */
export const HIVE_ROLES: readonly HiveRole[] = [
  'manager',
  'tech-lead',
  'senior',
  'intermediate',
  'junior',
  'qa',
];

/** The valid story statuses (for parse-time coercion). */
export const STORY_STATUSES: readonly StoryStatus[] = [
  'pending',
  'assigned',
  'in-progress',
  'review',
  'merged',
  'blocked',
  'abandoned',
];
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (types only; nothing imports them yet).

- [ ] **Step 3: Commit**

```bash
git add src/types/hive.ts
git commit -m "feat(hive): shared orchestration types for native state model"
```

---

## Task 2: Pure parsing + snapshot aggregation

**Files:**
- Create: `src/main/hive/parse.ts`
- Test: `src/main/hive/parse.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/parse.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import mock from 'mock-fs'

import {
  parseAgent,
  parseEventLine,
  parseRequirement,
  parseStory,
  readSnapshot,
  splitFrontmatter,
} from './parse'

afterEach(() => mock.restore())

describe('splitFrontmatter', () => {
  it('splits frontmatter from body', () => {
    const raw = '---\ntitle: Hello\nstatus: pending\n---\nthe body\nmore'
    const { data, body } = splitFrontmatter(raw)
    expect(data).toEqual({ title: 'Hello', status: 'pending' })
    expect(body).toBe('the body\nmore')
  })

  it('returns empty data + whole input as body when no frontmatter', () => {
    const { data, body } = splitFrontmatter('just text')
    expect(data).toEqual({})
    expect(body).toBe('just text')
  })
})

describe('parseStory', () => {
  it('parses a full story', () => {
    const raw = [
      '---',
      'title: Rate-limit the token endpoint',
      'status: review',
      'role: senior',
      'points: 3',
      'team: api',
      'assigned_to: a1b2',
      'feature_branch: feature/rate-limit',
      'depends_on: [STORY-1, STORY-2]',
      'acceptance_criteria:',
      '  - returns 429 over limit',
      'parent_requirement: REQ-9',
      'pr_url: https://x/pr/1',
      'created_at: 2026-06-03T00:00:00Z',
      'updated_at: 2026-06-03T01:00:00Z',
      '---',
      'Limit the endpoint.',
    ].join('\n')
    const s = parseStory(raw, 'STORY-7')
    expect(s).toEqual({
      id: 'STORY-7',
      title: 'Rate-limit the token endpoint',
      status: 'review',
      role: 'senior',
      points: 3,
      team: 'api',
      assignedTo: 'a1b2',
      featureBranch: 'feature/rate-limit',
      dependsOn: ['STORY-1', 'STORY-2'],
      acceptanceCriteria: ['returns 429 over limit'],
      parentRequirement: 'REQ-9',
      prUrl: 'https://x/pr/1',
      createdAt: '2026-06-03T00:00:00Z',
      updatedAt: '2026-06-03T01:00:00Z',
      mergedAt: undefined,
      body: 'Limit the endpoint.',
    })
  })

  it('coerces an unknown status to pending and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = parseStory('---\ntitle: X\nstatus: wat\nrole: junior\n---\n', 'S1')
    expect(s.status).toBe('pending')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('falls back to the id for a missing title, with empty defaults', () => {
    const s = parseStory('---\nstatus: pending\n---\n', 'S2')
    expect(s.title).toBe('S2')
    expect(s.points).toBe(0)
    expect(s.dependsOn).toEqual([])
    expect(s.acceptanceCriteria).toEqual([])
    expect(s.role).toBe('junior') // role fallback
  })
})

describe('parseAgent', () => {
  it('parses an agent and coerces unknown status to exited', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = [
      '---',
      'role: tech-lead',
      'status: wat',
      'team: api',
      'current_story: STORY-7',
      'worktree: repos/api--tech-lead-a1b2',
      'pid: 4242',
      'started_at: 2026-06-03T00:00:00Z',
      'note: decomposing',
      '---',
    ].join('\n')
    const a = parseAgent(raw, 'a1b2')
    expect(a).toEqual({
      id: 'a1b2',
      role: 'tech-lead',
      status: 'exited',
      team: 'api',
      currentStory: 'STORY-7',
      worktree: 'repos/api--tech-lead-a1b2',
      pid: 4242,
      startedAt: '2026-06-03T00:00:00Z',
      endedAt: undefined,
      note: 'decomposing',
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('parseRequirement', () => {
  it('parses a requirement', () => {
    const raw = [
      '---',
      'title: Add auth',
      'status: decomposed',
      'feature_branch: feature/auth',
      'decomposed_into: [STORY-1, STORY-2]',
      'created_at: 2026-06-03T00:00:00Z',
      'updated_at: 2026-06-03T01:00:00Z',
      '---',
      'Build auth.',
    ].join('\n')
    const r = parseRequirement(raw, 'REQ-1')
    expect(r.id).toBe('REQ-1')
    expect(r.status).toBe('decomposed')
    expect(r.decomposedInto).toEqual(['STORY-1', 'STORY-2'])
    expect(r.body).toBe('Build auth.')
  })
})

describe('parseEventLine', () => {
  it('parses a valid ndjson line', () => {
    const line = JSON.stringify({
      ts: '2026-06-03T00:00:00Z',
      actor: 'manager',
      event: 'spawned',
      detail: 'STORY-7',
      level: 'ok',
    })
    expect(parseEventLine(line)).toEqual({
      ts: '2026-06-03T00:00:00Z',
      actor: 'manager',
      event: 'spawned',
      detail: 'STORY-7',
      level: 'ok',
    })
  })

  it('returns null for blank or invalid JSON', () => {
    expect(parseEventLine('')).toBeNull()
    expect(parseEventLine('   ')).toBeNull()
    expect(parseEventLine('{not json')).toBeNull()
  })

  it('defaults an unknown level to info', () => {
    const line = JSON.stringify({ ts: 't', actor: 'a', event: 'e', detail: 'd', level: 'zzz' })
    expect(parseEventLine(line)?.level).toBe('info')
  })
})

describe('readSnapshot', () => {
  it('aggregates stories, agents, requirements; skips a malformed file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mock({
      '/ws/.hive/state/stories/STORY-1.md':
        '---\ntitle: One\nstatus: pending\nrole: junior\n---\n',
      '/ws/.hive/state/stories/STORY-2.md':
        '---\ntitle: Two\nstatus: review\nrole: senior\n---\n',
      '/ws/.hive/state/agents/a1.md':
        '---\nrole: senior\nstatus: live\nteam: api\nstarted_at: t\n---\n',
      '/ws/.hive/state/requirements/REQ-1.md':
        '---\ntitle: Req\nstatus: pending\n---\n',
      // not a .md file → ignored
      '/ws/.hive/state/stories/notes.txt': 'ignore me',
    })
    const snap = await readSnapshot('/ws/.hive/state')
    expect(snap.stories.map((s) => s.id).sort()).toEqual(['STORY-1', 'STORY-2'])
    expect(snap.agents.map((a) => a.id)).toEqual(['a1'])
    expect(snap.requirements.map((r) => r.id)).toEqual(['REQ-1'])
    warn.mockRestore()
  })

  it('returns empty arrays when state dirs are missing', async () => {
    mock({ '/ws/.hive': {} })
    const snap = await readSnapshot('/ws/.hive/state')
    expect(snap).toEqual({ requirements: [], stories: [], agents: [] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/hive/parse.test.ts`
Expected: FAIL — cannot resolve `./parse`.

- [ ] **Step 3: Write the implementation**

Create `src/main/hive/parse.ts`:

```ts
/**
 * Pure parsing for the `.hive/state/**` files + `events.ndjson`.
 *
 * Kept free of IPC and chokidar so it is unit-testable (mock-fs for the
 * directory reads). The reader (./reader.ts) wires these into a watcher.
 *
 * Robustness rule (spec §Error handling): one bad file/line must never blank
 * the view — unparseable files are skipped, unknown enum values are coerced
 * to a typed fallback, and both warn.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  HIVE_ROLES,
  STORY_STATUSES,
  type HiveAgent,
  type HiveEvent,
  type HiveEventLevel,
  type HiveRequirement,
  type HiveRole,
  type HiveSnapshot,
  type HiveStory,
  type RequirementStatus,
  type StoryStatus,
} from '../../types/hive';

const REQ_STATUSES: readonly RequirementStatus[] = [
  'pending',
  'decomposed',
  'in-flight',
  'complete',
  'blocked',
];
const EVENT_LEVELS: readonly HiveEventLevel[] = ['info', 'ok', 'warn', 'pr'];

/** Split a `---`-delimited YAML frontmatter block from the markdown body. */
export function splitFrontmatter(raw: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const text = raw.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { data, body: (match[2] ?? '').trim() };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
function role(v: unknown, where: string): HiveRole {
  if (typeof v === 'string' && (HIVE_ROLES as readonly string[]).includes(v)) {
    return v as HiveRole;
  }
  if (v !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(`hive parse: unknown role "${String(v)}" in ${where}, using junior`);
  }
  return 'junior';
}

export function parseStory(raw: string, id: string): HiveStory {
  const { data, body } = splitFrontmatter(raw);
  let status = data.status as unknown;
  if (typeof status !== 'string' || !(STORY_STATUSES as readonly string[]).includes(status)) {
    if (status !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(`hive parse: unknown story status "${String(status)}" in ${id}, using pending`);
    }
    status = 'pending';
  }
  return {
    id,
    title: str(data.title) ?? id,
    status: status as StoryStatus,
    role: role(data.role, id),
    points: num(data.points),
    team: str(data.team) ?? '',
    assignedTo: str(data.assigned_to),
    featureBranch: str(data.feature_branch),
    dependsOn: list(data.depends_on),
    acceptanceCriteria: list(data.acceptance_criteria),
    parentRequirement: str(data.parent_requirement),
    prUrl: str(data.pr_url),
    createdAt: str(data.created_at) ?? '',
    updatedAt: str(data.updated_at) ?? '',
    mergedAt: str(data.merged_at),
    body,
  };
}

export function parseAgent(raw: string, id: string): HiveAgent {
  const { data } = splitFrontmatter(raw);
  let status = data.status as unknown;
  if (status !== 'live' && status !== 'exited') {
    if (status !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(`hive parse: unknown agent status "${String(status)}" in ${id}, using exited`);
    }
    status = 'exited';
  }
  return {
    id,
    role: role(data.role, id),
    status: status as HiveAgent['status'],
    team: str(data.team) ?? '',
    currentStory: str(data.current_story),
    worktree: str(data.worktree),
    pid: typeof data.pid === 'number' ? data.pid : undefined,
    startedAt: str(data.started_at) ?? '',
    endedAt: str(data.ended_at),
    note: str(data.note),
  };
}

export function parseRequirement(raw: string, id: string): HiveRequirement {
  const { data, body } = splitFrontmatter(raw);
  let status = data.status as unknown;
  if (typeof status !== 'string' || !(REQ_STATUSES as readonly string[]).includes(status)) {
    if (status !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(`hive parse: unknown requirement status "${String(status)}" in ${id}, using pending`);
    }
    status = 'pending';
  }
  return {
    id,
    title: str(data.title) ?? id,
    status: status as RequirementStatus,
    featureBranch: str(data.feature_branch),
    decomposedInto: list(data.decomposed_into),
    createdAt: str(data.created_at) ?? '',
    updatedAt: str(data.updated_at) ?? '',
    body,
  };
}

export function parseEventLine(line: string): HiveEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const level =
    typeof obj.level === 'string' && (EVENT_LEVELS as readonly string[]).includes(obj.level)
      ? (obj.level as HiveEventLevel)
      : 'info';
  return {
    ts: str(obj.ts) ?? '',
    actor: str(obj.actor) ?? '',
    event: str(obj.event) ?? '',
    detail: str(obj.detail) ?? '',
    level,
  };
}

/** Read + parse every `<stateDir>/<kind>/*.md`, aggregate into a snapshot. */
export async function readSnapshot(stateDir: string): Promise<HiveSnapshot> {
  const [requirements, stories, agents] = await Promise.all([
    readKind(join(stateDir, 'requirements'), parseRequirement),
    readKind(join(stateDir, 'stories'), parseStory),
    readKind(join(stateDir, 'agents'), parseAgent),
  ]);
  return { requirements, stories, agents };
}

async function readKind<T>(
  dir: string,
  parseOne: (raw: string, id: string) => T,
): Promise<T[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // dir missing → empty
  }
  const out: T[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    try {
      const raw = await fs.readFile(join(dir, name), 'utf8');
      out.push(parseOne(raw, id));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`hive parse: failed to read ${join(dir, name)}`, e);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/hive/parse.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/types/hive.ts src/main/hive/parse.ts src/main/hive/parse.test.ts
git commit -m "feat(hive): pure parsing + snapshot aggregation for .hive/state"
```

---

## Task 3: View adapter (native model → existing panel props)

**Files:**
- Create: `src/renderer/src/lib/hiveView.ts`
- Test: `src/renderer/src/lib/hiveView.test.ts`

The existing panels render the seed shapes `Board`, `Agent`, `LogLine`, `RoleKey` from `src/renderer/src/data/seed.ts`. This adapter maps the native model onto them so the panels don't change shape.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/hiveView.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { toBoard, toLogLines, toRoster } from './hiveView'
import type { HiveAgent, HiveEvent, HiveStory } from '../../../types/hive'

const story = (over: Partial<HiveStory>): HiveStory => ({
  id: 'S',
  title: 'S',
  status: 'pending',
  role: 'junior',
  points: 1,
  team: 'api',
  dependsOn: [],
  acceptanceCriteria: [],
  createdAt: '',
  updatedAt: '',
  body: '',
  ...over,
})

describe('toBoard', () => {
  it('buckets statuses into pending/running/review/done', () => {
    const board = toBoard([
      story({ id: 'a', status: 'pending' }),
      story({ id: 'b', status: 'assigned' }),
      story({ id: 'c', status: 'in-progress' }),
      story({ id: 'd', status: 'review' }),
      story({ id: 'e', status: 'merged' }),
      story({ id: 'f', status: 'blocked' }),
      story({ id: 'g', status: 'abandoned' }),
    ])
    expect(board.pending.map((s) => s.id)).toEqual(['a', 'b', 'f', 'g'])
    expect(board.running.map((s) => s.id)).toEqual(['c'])
    expect(board.review.map((s) => s.id)).toEqual(['d'])
    expect(board.done.map((s) => s.id)).toEqual(['e'])
  })

  it('maps tech-lead role to the techlead seed key', () => {
    const board = toBoard([story({ id: 'a', role: 'tech-lead' })])
    expect(board.pending[0].role).toBe('techlead')
  })
})

describe('toRoster', () => {
  it('maps agents to roster rows (live→running, exited→done)', () => {
    const agents: HiveAgent[] = [
      { id: 'a1', role: 'senior', status: 'live', team: 'api', startedAt: '', note: 'reviewing' },
      { id: 'a2', role: 'qa', status: 'exited', team: 'api', startedAt: '' },
    ]
    const roster = toRoster(agents)
    expect(roster[0]).toMatchObject({ role: 'senior', status: 'running', note: 'reviewing' })
    expect(roster[1]).toMatchObject({ role: 'qa', status: 'done' })
  })

  it('falls back to currentStory when note is absent', () => {
    const roster = toRoster([
      { id: 'a', role: 'junior', status: 'live', team: 'api', startedAt: '', currentStory: 'S-3' },
    ])
    expect(roster[0].note).toContain('S-3')
  })
})

describe('toLogLines', () => {
  it('maps events to LogLine, level→cls and ts→HH:MM', () => {
    const events: HiveEvent[] = [
      { ts: '2026-06-03T09:05:00Z', actor: 'manager', event: 'spawned', detail: 'S-7', level: 'ok' },
      { ts: 'bad', actor: 'mgr', event: 'tick', detail: '', level: 'warn' },
    ]
    const lines = toLogLines(events)
    expect(lines[0]).toMatchObject({ cls: 'ok' })
    expect(lines[0].txt).toContain('spawned')
    expect(lines[1].cls).toBe('dim') // warn → dim
    expect(lines[1].t).toBe('--:--') // unparseable ts
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/lib/hiveView.test.ts`
Expected: FAIL — cannot resolve `./hiveView`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/lib/hiveView.ts`:

```ts
/**
 * Adapter: native hive model → the existing seed-shaped panel props
 * (`Board`, `Agent`, `LogLine`, `RoleKey`). Keeping it pure (no React, no
 * IPC) makes it unit-testable and keeps the panels unchanged.
 */
import type {
  Agent,
  Board,
  LogClass,
  LogLine,
  RoleKey,
  Story as SeedStory,
} from '../data/seed'
import type {
  HiveAgent,
  HiveEvent,
  HiveEventLevel,
  HiveRole,
  HiveStory,
  StoryStatus,
} from '../../../types/hive'

/** Native role → seed RoleKey (only `tech-lead`→`techlead` differs). */
function roleKey(role: HiveRole): RoleKey {
  return role === 'tech-lead' ? 'techlead' : role
}

/** Which board column a story status lands in. */
function column(status: StoryStatus): keyof Board {
  switch (status) {
    case 'in-progress':
      return 'running'
    case 'review':
      return 'review'
    case 'merged':
      return 'done'
    case 'pending':
    case 'assigned':
    case 'blocked':
    case 'abandoned':
    default:
      return 'pending'
  }
}

function toSeedStory(s: HiveStory): SeedStory {
  return {
    id: s.id,
    title: s.title,
    pts: s.points,
    role: roleKey(s.role),
    status:
      s.status === 'in-progress'
        ? 'running'
        : s.status === 'merged'
          ? 'done'
          : s.status === 'review'
            ? 'review'
            : 'pending',
  }
}

export function toBoard(stories: readonly HiveStory[]): Board {
  const board: Board = { pending: [], running: [], review: [], done: [] }
  for (const s of stories) board[column(s.status)].push(toSeedStory(s))
  return board
}

const ROLE_LABEL: Record<RoleKey, string> = {
  manager: 'Manager',
  techlead: 'Tech Lead',
  senior: 'Senior',
  intermediate: 'Intermediate',
  junior: 'Junior',
  qa: 'QA',
}

export function toRoster(agents: readonly HiveAgent[]): Agent[] {
  return agents.map((a): Agent => {
    const key = roleKey(a.role)
    const note = a.note ?? (a.currentStory ? `on ${a.currentStory}` : 'idle')
    return {
      role: key,
      name: ROLE_LABEL[key],
      status: a.status === 'live' ? 'running' : 'done',
      note,
      file: undefined,
    }
  })
}

const LEVEL_CLASS: Record<HiveEventLevel, LogClass> = {
  info: '',
  ok: 'ok',
  warn: 'dim',
  pr: 'pr',
}

/** Format an ISO timestamp to `HH:MM`, or `--:--` if unparseable. */
function hhmm(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--'
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

export function toLogLines(events: readonly HiveEvent[]): LogLine[] {
  return events.map((e): LogLine => {
    const txt = e.detail ? `${e.event} — ${e.detail}` : e.event
    return {
      t: hhmm(e.ts),
      cls: LEVEL_CLASS[e.level],
      txt: e.actor ? `${e.actor}: ${txt}` : txt,
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/lib/hiveView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/hiveView.ts src/renderer/src/lib/hiveView.test.ts
git commit -m "feat(hive): pure adapter from native model to panel props"
```

---

## Task 4: Persist `hiveWorkspacePath` on the project

**Files:**
- Modify: `src/types/workspace.ts` (Project ~line 33; ProjectSession ~line 96)
- Modify: `src/renderer/src/store/workspaceStore.ts`
- Test: `src/main/state/migrate.test.ts`

- [ ] **Step 1: Add the field to the types**

In `src/types/workspace.ts`, inside `interface Project` (after `lastOpenedAt`):

```ts
  /** Absolute path of the hive workspace bound to this project, if any. */
  hiveWorkspacePath?: string;
```

And inside `interface ProjectSession` (after `lastOpenedAt`):

```ts
  /** Absolute path of the bound hive workspace, if any. */
  hiveWorkspacePath?: string;
```

- [ ] **Step 2: Write the failing migrate test**

In `src/main/state/migrate.test.ts`, add a case asserting an existing project's `hiveWorkspacePath` survives a migrate round-trip. (Find the existing `describe`/helper that builds a v-current persisted state with a project, and add:)

```ts
it('preserves hiveWorkspacePath on a project through migrate', () => {
  const input = {
    version: CURRENT_VERSION,
    lastProjectId: 'p1',
    recents: [],
    projects: {
      p1: {
        id: 'p1',
        name: 'P1',
        repos: [],
        createdAt: 0,
        lastOpenedAt: 0,
        hiveWorkspacePath: '/ws/p1',
        expandedPaths: [],
        openTabs: [],
        activeTabPath: null,
      },
    },
    window: null,
    layout: DEFAULT_LAYOUT_PERSISTED,
    enabledPlugins: {},
  }
  const out = migrate(input)
  expect(out.projects.p1.hiveWorkspacePath).toBe('/ws/p1')
})
```

Match the test file's existing import names for `CURRENT_VERSION` / `DEFAULT_LAYOUT_PERSISTED` / `migrate` (read the top of `migrate.test.ts`; if a constant has a different name, use the existing one). If the migrate path already passes projects through verbatim, the test passes immediately after the type change — that is the expected, correct outcome (it's a guard against future regressions).

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/main/state/migrate.test.ts`
Expected: PASS (the optional field rides through the existing project-preserving migrate; no migrate code change needed — the test locks it in).

- [ ] **Step 4: Add the store action + thread through session (de)serialization**

In `src/renderer/src/store/workspaceStore.ts`:

a) In the `WorkspaceState` interface, near `setProject`, add:

```ts
  /** Bind (or clear) the hive workspace path on the active project. */
  setHiveWorkspacePath: (path: string | null) => void
```

b) In the store creator (near the existing `setProject` implementation), add:

```ts
  setHiveWorkspacePath: (path) =>
    set((s) =>
      s.project
        ? { project: { ...s.project, hiveWorkspacePath: path ?? undefined } }
        : {},
    ),
```

c) Thread the field through session serialization. Grep the store (and `App.tsx`) for where a `ProjectSession` / snapshot is built from the active project and where `hydrateFromSession` reads it back. Add `hiveWorkspacePath` alongside `repos` in BOTH directions:
- When building the session/snapshot: `hiveWorkspacePath: project.hiveWorkspacePath,`
- In `hydrateFromSession` (and the App boot path that calls `setProject` from a `ProjectSession`): carry `hiveWorkspacePath: session.hiveWorkspacePath` onto the rebuilt `Project`.

Run: `grep -n "repos:" src/renderer/src/store/workspaceStore.ts src/renderer/src/App.tsx` to find every place a project↔session is mapped, and add the field next to `repos` at each.

- [ ] **Step 5: Typecheck + store tests**

Run: `npm run typecheck && npx vitest run src/renderer/src/store/workspaceStore.test.ts src/main/state/migrate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/workspace.ts src/renderer/src/store/workspaceStore.ts src/main/state/migrate.test.ts
git commit -m "feat(hive): persist hiveWorkspacePath on the project"
```

---

## Task 5: Hive reader (watch + tail + push)

**Files:**
- Create: `src/main/hive/reader.ts`

This is integration glue (chokidar + IPC push) mirroring `src/main/project/handlers.ts`; verified by typecheck + the manual run in Task 9, not a unit test.

- [ ] **Step 1: Write the reader**

Create `src/main/hive/reader.ts`:

```ts
/**
 * Hive state reader — owns the ONE active hive workspace at a time.
 *
 * Given a workspace path, it watches `<ws>/.hive/state/` + `<ws>/.hive/events.ndjson`
 * with chokidar (same approach as the project watcher), re-reads on change,
 * and pushes `HiveSnapshot` / `HiveEvent[]` / `HiveConnection` to the renderer
 * via the injected `send`. Files are the source of truth — see parse.ts.
 */
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

import type {
  HiveConnection,
  HiveEvent,
  HiveSessionBundle,
  HiveSnapshot,
} from '../../types/hive';
import { parseEventLine, readSnapshot } from './parse';

const DEBOUNCE_MS = 100;
const MAX_TAIL = 500;

export const HIVE_EVENTS = {
  snapshot: 'event:hive:snapshot',
  events: 'event:hive:events',
  connection: 'event:hive:connection',
} as const;

type Send = (channel: string, payload: unknown) => void;

const EMPTY_SNAPSHOT: HiveSnapshot = { requirements: [], stories: [], agents: [] };

class HiveReader {
  #send: Send | null = null;
  #watcher: FSWatcher | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;

  #workspacePath: string | null = null;
  #connection: HiveConnection = { state: 'no-workspace' };
  #snapshot: HiveSnapshot = EMPTY_SNAPSHOT;
  #events: HiveEvent[] = [];
  #eventBytes = 0; // how many bytes of events.ndjson we've consumed

  setSend(send: Send): void {
    this.#send = send;
  }

  /** Re-point at a workspace (or null to disconnect). Returns the fresh bundle. */
  async setWorkspace(path: string | null): Promise<HiveSessionBundle> {
    this.#teardownWatcher();
    this.#workspacePath = path;
    this.#snapshot = EMPTY_SNAPSHOT;
    this.#events = [];
    this.#eventBytes = 0;

    if (!path) {
      this.#connection = { state: 'no-workspace' };
      return this.bundle();
    }
    if (!existsSync(join(path, '.hive'))) {
      this.#connection = { state: 'not-found', path };
      return this.bundle();
    }
    this.#connection = { state: 'connected', path };
    await this.#reloadSnapshot();
    await this.#reloadEvents(true);
    this.#startWatcher(path);
    return this.bundle();
  }

  bundle(): HiveSessionBundle {
    return {
      connection: this.#connection,
      snapshot: this.#snapshot,
      events: this.#events,
    };
  }

  teardown(): void {
    this.#teardownWatcher();
    this.#workspacePath = null;
    this.#send = null;
  }

  // --- internals --------------------------------------------------------

  #stateDir(): string {
    return join(this.#workspacePath as string, '.hive', 'state');
  }
  #eventsFile(): string {
    return join(this.#workspacePath as string, '.hive', 'events.ndjson');
  }

  #startWatcher(path: string): void {
    const watcher = chokidarWatch(
      [join(path, '.hive', 'state'), join(path, '.hive', 'events.ndjson')],
      { ignoreInitial: true, persistent: true },
    );
    watcher.on('all', () => this.#scheduleReload());
    watcher.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.warn('hive reader: watcher error', e);
    });
    this.#watcher = watcher;
  }

  #scheduleReload(): void {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.#reloadSnapshot().then(() => this.#reloadEvents(false));
    }, DEBOUNCE_MS);
  }

  async #reloadSnapshot(): Promise<void> {
    if (!this.#workspacePath) return;
    try {
      this.#snapshot = await readSnapshot(this.#stateDir());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('hive reader: snapshot read failed', e);
      this.#snapshot = EMPTY_SNAPSHOT;
    }
    this.#send?.(HIVE_EVENTS.snapshot, this.#snapshot);
  }

  /** Read events.ndjson; on `full`, parse all, else only the appended tail. */
  async #reloadEvents(full: boolean): Promise<void> {
    if (!this.#workspacePath) return;
    let raw: string;
    try {
      const buf = await fs.readFile(this.#eventsFile());
      // If the file shrank (rotated/truncated), re-read from the start.
      if (buf.byteLength < this.#eventBytes) {
        this.#eventBytes = 0;
        this.#events = [];
        full = true;
      }
      raw = full ? buf.toString('utf8') : buf.subarray(this.#eventBytes).toString('utf8');
      this.#eventBytes = buf.byteLength;
    } catch {
      return; // no events file yet
    }
    const fresh: HiveEvent[] = [];
    for (const line of raw.split('\n')) {
      const ev = parseEventLine(line);
      if (ev) fresh.push(ev);
    }
    if (fresh.length === 0) return;
    this.#events = [...this.#events, ...fresh].slice(-MAX_TAIL);
    this.#send?.(HIVE_EVENTS.events, fresh);
  }

  #teardownWatcher(): void {
    if (this.#debounce) {
      clearTimeout(this.#debounce);
      this.#debounce = null;
    }
    if (this.#watcher) {
      void this.#watcher.close();
      this.#watcher = null;
    }
  }
}

/** Process-wide singleton — one active workspace at a time. */
export const hiveReader = new HiveReader();
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/hive/reader.ts
git commit -m "feat(hive): main-process reader (watch .hive/state + tail events)"
```

---

## Task 6: Hive IPC handlers + main wiring

**Files:**
- Create: `src/main/hive/handlers.ts`
- Modify: `src/main/index.ts` (register near line 145-160; teardown near line 180)

- [ ] **Step 1: Write the handlers**

Create `src/main/hive/handlers.ts`:

```ts
/**
 * `ipc:hive:*` handlers for the native-orchestration viewer (slice 1).
 *
 * - connect-workspace: open a directory picker, validate `<dir>/.hive`,
 *   point the reader at it, return the connection.
 * - set-workspace: re-point the reader at a path (or null). Used when the
 *   active project changes. Returns the full bundle.
 * - get-snapshot: return the current bundle (cold subscribers).
 *
 * Pushes (snapshot/events/connection) are emitted by the reader via the
 * injected `send`, which targets the main window's webContents.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { HiveConnection, HiveSessionBundle } from '../../types/hive';
import { hiveReader } from './reader';

export const HIVE_CHANNELS = {
  connectWorkspace: 'ipc:hive:connect-workspace',
  setWorkspace: 'ipc:hive:set-workspace',
  getSnapshot: 'ipc:hive:get-snapshot',
} as const;

export interface HiveHandlerDeps {
  getMainWindow: () => BrowserWindow | null;
}

export function registerHiveHandlers(deps: HiveHandlerDeps): () => void {
  hiveReader.setSend((channel, payload) => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  });

  ipcMain.handle(
    HIVE_CHANNELS.connectWorkspace,
    async (): Promise<{ connection: HiveConnection }> => {
      const win = deps.getMainWindow();
      const res = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (res.canceled || res.filePaths.length === 0) {
        return { connection: hiveReader.bundle().connection };
      }
      const picked = res.filePaths[0];
      if (!existsSync(join(picked, '.hive'))) {
        // Let the reader produce the canonical not-found connection.
        const bundle = await hiveReader.setWorkspace(picked);
        return { connection: bundle.connection };
      }
      const bundle = await hiveReader.setWorkspace(picked);
      return { connection: bundle.connection };
    },
  );

  ipcMain.handle(
    HIVE_CHANNELS.setWorkspace,
    async (_e, path: string | null): Promise<HiveSessionBundle> => {
      return hiveReader.setWorkspace(path ?? null);
    },
  );

  ipcMain.handle(
    HIVE_CHANNELS.getSnapshot,
    async (): Promise<HiveSessionBundle> => hiveReader.bundle(),
  );

  return () => {
    ipcMain.removeHandler(HIVE_CHANNELS.connectWorkspace);
    ipcMain.removeHandler(HIVE_CHANNELS.setWorkspace);
    ipcMain.removeHandler(HIVE_CHANNELS.getSnapshot);
    hiveReader.teardown();
  };
}
```

- [ ] **Step 2: Wire into `src/main/index.ts`**

Add the import alongside the other handler imports (~line 28-40):

```ts
import { registerHiveHandlers } from './hive/handlers';
```

Add a teardown holder near the other `teardown*` declarations (search for `let teardownGitHandlers`):

```ts
let teardownHiveHandlers: (() => void) | undefined;
```

In the bootstrap block (after `teardownGitHandlers = registerGitHandlers();`, ~line 160):

```ts
  teardownHiveHandlers = registerHiveHandlers({ getMainWindow: () => mainWindow });
```

In the quit/teardown block (near `unregisterStateIpc();`, ~line 180), add:

```ts
  teardownHiveHandlers?.();
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add src/main/hive/handlers.ts src/main/index.ts
git commit -m "feat(hive): ipc:hive:* handlers + main-process wiring"
```

---

## Task 7: Preload bridge (`window.hive.orchestration`)

**Files:**
- Modify: `src/preload/api.ts` (add to `HiveBridge` ~line 355; re-export hive types)
- Modify: `src/preload/index.ts` (channels + implementation)

- [ ] **Step 1: Extend the API types**

In `src/preload/api.ts`, add an import of the hive types near the top type imports:

```ts
import type {
  HiveConnection,
  HiveEvent,
  HiveSessionBundle,
  HiveSnapshot,
} from '../types/hive';
```

Add the bridge interface (near `HiveProjectBridge`):

```ts
export type HiveSnapshotHandler = (snapshot: HiveSnapshot) => void;
export type HiveEventsHandler = (events: HiveEvent[]) => void;
export type HiveConnectionHandler = (connection: HiveConnection) => void;

export interface HiveOrchestrationBridge {
  /** Open a directory picker, validate `<dir>/.hive`, start watching. */
  connectWorkspace(): Promise<{ connection: HiveConnection }>;
  /** Re-point at a workspace path (or null to disconnect). */
  setWorkspace(path: string | null): Promise<HiveSessionBundle>;
  /** Current bundle for cold subscribers. */
  getSnapshot(): Promise<HiveSessionBundle>;
  onSnapshot(handler: HiveSnapshotHandler): Unsubscribe;
  onEvents(handler: HiveEventsHandler): Unsubscribe;
  onConnection(handler: HiveConnectionHandler): Unsubscribe;
}
```

Add `orchestration` to the `HiveBridge` interface (alongside `project`, `terminal`, etc.):

```ts
  orchestration: HiveOrchestrationBridge;
```

Re-export the hive types so the renderer can import from the bridge surface (end of file, next to other re-exports):

```ts
export type { HiveConnection, HiveEvent, HiveSnapshot, HiveSessionBundle } from '../types/hive';
```

- [ ] **Step 2: Implement in `src/preload/index.ts`**

Add channel constants (next to the other `const PROJECT = {...}` groups):

```ts
const HIVE = {
  connectWorkspace: 'ipc:hive:connect-workspace',
  setWorkspace: 'ipc:hive:set-workspace',
  getSnapshot: 'ipc:hive:get-snapshot',
  evtSnapshot: 'event:hive:snapshot',
  evtEvents: 'event:hive:events',
  evtConnection: 'event:hive:connection',
} as const;
```

In the object passed to `contextBridge.exposeInMainWorld('hive', { ... })`, add the `orchestration` property (mirror the existing subscribe pattern used by `onFsChange`):

```ts
    orchestration: {
      connectWorkspace: () => ipcRenderer.invoke(HIVE.connectWorkspace),
      setWorkspace: (path: string | null) => ipcRenderer.invoke(HIVE.setWorkspace, path),
      getSnapshot: () => ipcRenderer.invoke(HIVE.getSnapshot),
      onSnapshot: (handler: (s: unknown) => void): (() => void) => {
        const listener = (_e: IpcRendererEvent, s: unknown) => handler(s);
        ipcRenderer.on(HIVE.evtSnapshot, listener);
        return () => ipcRenderer.removeListener(HIVE.evtSnapshot, listener);
      },
      onEvents: (handler: (e: unknown) => void): (() => void) => {
        const listener = (_e: IpcRendererEvent, payload: unknown) => handler(payload);
        ipcRenderer.on(HIVE.evtEvents, listener);
        return () => ipcRenderer.removeListener(HIVE.evtEvents, listener);
      },
      onConnection: (handler: (c: unknown) => void): (() => void) => {
        const listener = (_e: IpcRendererEvent, c: unknown) => handler(c);
        ipcRenderer.on(HIVE.evtConnection, listener);
        return () => ipcRenderer.removeListener(HIVE.evtConnection, listener);
      },
    },
```

(Match the exact typing/casts the file already uses for `onFsChange`/`onData`. If the file casts handlers to the precise `Hive*Handler` types from `./api`, use those instead of `unknown`.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/preload/api.ts src/preload/index.ts
git commit -m "feat(hive): preload bridge window.hive.orchestration"
```

---

## Task 8: Renderer store slice + subscription hook

**Files:**
- Create: `src/renderer/src/lib/useHiveSession.ts`
- Modify: `src/renderer/src/App.tsx` (call the hook near the other top-level hooks ~line 200)

Mirrors the `useProjectWatchers` pattern: a small store holding the live session, fed by the three subscriptions, re-pointed when the active project changes.

- [ ] **Step 1: Write the store + hook**

Create `src/renderer/src/lib/useHiveSession.ts`:

```ts
/**
 * Live hive-session state for the renderer + the subscription hook.
 *
 * A tiny zustand store holds `{ connection, snapshot, events }`. `useHiveSession`
 * (called once in the app shell) subscribes to the preload pushes and re-points
 * the reader whenever the active project's `hiveWorkspacePath` changes — the
 * same store-driven pattern as `useProjectWatchers`.
 */
import { useEffect } from 'react'
import { create } from 'zustand'

import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  HiveConnection,
  HiveEvent,
  HiveSnapshot,
} from '../../../types/hive'

const EMPTY_SNAPSHOT: HiveSnapshot = { requirements: [], stories: [], agents: [] }
const MAX_TAIL = 500

interface HiveSessionState {
  connection: HiveConnection
  snapshot: HiveSnapshot
  events: HiveEvent[]
  setConnection: (c: HiveConnection) => void
  setSnapshot: (s: HiveSnapshot) => void
  appendEvents: (e: HiveEvent[]) => void
  reset: (c: HiveConnection, s: HiveSnapshot, e: HiveEvent[]) => void
}

export const useHiveSessionStore = create<HiveSessionState>((set) => ({
  connection: { state: 'no-workspace' },
  snapshot: EMPTY_SNAPSHOT,
  events: [],
  setConnection: (connection) => set({ connection }),
  setSnapshot: (snapshot) => set({ snapshot }),
  appendEvents: (e) =>
    set((s) => ({ events: [...s.events, ...e].slice(-MAX_TAIL) })),
  reset: (connection, snapshot, events) => set({ connection, snapshot, events }),
}))

/** Subscribe to hive pushes + re-point on project workspace change. */
export function useHiveSession(): void {
  const hiveWorkspacePath = useWorkspaceStore(
    (s) => s.project?.hiveWorkspacePath ?? null,
  )

  // Establish the three subscriptions once.
  useEffect(() => {
    const bridge = window.hive?.orchestration
    if (!bridge) return
    const store = useHiveSessionStore.getState()
    const unsubs = [
      bridge.onSnapshot((snap) => store.setSnapshot(snap)),
      bridge.onEvents((evs) => store.appendEvents(evs)),
      bridge.onConnection((conn) => store.setConnection(conn)),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // Re-point the reader whenever the active project's workspace path changes.
  useEffect(() => {
    const bridge = window.hive?.orchestration
    if (!bridge) return
    let cancelled = false
    void bridge
      .setWorkspace(hiveWorkspacePath)
      .then((bundle) => {
        if (cancelled) return
        useHiveSessionStore
          .getState()
          .reset(bundle.connection, bundle.snapshot, bundle.events)
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('useHiveSession: setWorkspace failed', e)
      })
    return () => {
      cancelled = true
    }
  }, [hiveWorkspacePath])
}
```

- [ ] **Step 2: Call the hook in `App.tsx`**

Add the import near the other `./lib/*` imports:

```ts
import { useHiveSession } from './lib/useHiveSession'
```

In the `App()` body, right after the existing `useProjectWatchers()` call (~line 200):

```ts
  // Subscribe to the active project's live hive session (slice 1 viewer).
  useHiveSession()
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/useHiveSession.ts src/renderer/src/App.tsx
git commit -m "feat(hive): renderer hive-session store + subscription hook"
```

---

## Task 9: Wire the panels to live state + connection states

**Files:**
- Modify: `src/renderer/src/App.tsx` (the `<Dock>` + `<BottomPanel>` props ~line 874-893)
- Modify: `src/renderer/src/components/AgentDock.tsx` (no-workspace/idle state; drop ribbon ~line 378)
- Modify: `src/renderer/src/components/BottomPanel.tsx` (drop ribbon on the manager-log tab ~line 146)

- [ ] **Step 1: Derive live panel props in `App.tsx`**

Near the top of `App()` (after `useHiveSession()`), derive the adapted props and the connect handler:

```ts
  const hiveConnection = useHiveSessionStore((s) => s.connection)
  const hiveSnapshot = useHiveSessionStore((s) => s.snapshot)
  const hiveEvents = useHiveSessionStore((s) => s.events)
  const setHiveWorkspacePath = useWorkspaceStore((s) => s.setHiveWorkspacePath)

  const liveRoster = useMemo(() => toRoster(hiveSnapshot.agents), [hiveSnapshot.agents])
  const liveBoard = useMemo(() => toBoard(hiveSnapshot.stories), [hiveSnapshot.stories])
  const liveLog = useMemo(() => toLogLines(hiveEvents), [hiveEvents])

  const onConnectHive = useCallback(async () => {
    const bridge = window.hive?.orchestration
    if (!bridge) return
    const { connection } = await bridge.connectWorkspace()
    if (connection.state === 'connected') setHiveWorkspacePath(connection.path)
  }, [setHiveWorkspacePath])
```

Add the imports near the other `./lib/*` imports:

```ts
import { useHiveSessionStore } from './lib/useHiveSession'
import { toBoard, toLogLines, toRoster } from './lib/hiveView'
```

- [ ] **Step 2: Pass live props (replace the seed `roster`/`board`/`log`)**

Change the `<Dock>` usage (currently `board={board} roster={roster}`) to:

```tsx
      <Dock
        onOpenFile={onOpenFile}
        board={liveBoard}
        roster={liveRoster}
        chat={chat}
        hiveConnection={hiveConnection}
        onConnectHive={onConnectHive}
      />
```

Change the `<BottomPanel>` `log={log}` to `log={liveLog}`.

(Leave `chat` from seed — out of scope this slice.) Remove now-unused `roster`, `board`, `log` from the `./data/seed` import in `App.tsx` if they are no longer referenced (run `grep -n "\\broster\\b\\|\\bboard\\b\\|\\blog\\b" src/renderer/src/App.tsx` to confirm before deleting each).

- [ ] **Step 3: Add the connection prop + state to `Dock`**

In `src/renderer/src/components/AgentDock.tsx`, extend `DockProps`:

```ts
import type { HiveConnection } from '../../../types/hive'

export interface DockProps {
  onOpenFile: OpenFile
  board: Board
  roster: Agent[]
  chat: ChatMsg[]
  hiveConnection: HiveConnection
  onConnectHive: () => void
}
```

In `Dock(...)`, destructure the new props and replace the `<MockDataRibbon />` (~line 378) with a connection banner:

```tsx
export function Dock({ onOpenFile, board, roster, chat, hiveConnection, onConnectHive }: DockProps) {
  const [tab, setTab] = useState<TabKey>('run')
  // ...existing tab markup...
```

Replace `<MockDataRibbon />` with:

```tsx
      {hiveConnection.state === 'no-workspace' && (
        <div className="hive-banner">
          No hive workspace connected.{' '}
          <button type="button" className="hive-connect-btn" onClick={onConnectHive}>
            Connect…
          </button>
        </div>
      )}
      {hiveConnection.state === 'not-found' && (
        <div className="hive-banner">
          Workspace not found: {hiveConnection.path}.{' '}
          <button type="button" className="hive-connect-btn" onClick={onConnectHive}>
            Reconnect…
          </button>
        </div>
      )}
```

Remove the now-unused `import { MockDataRibbon } from './MockDataRibbon'` from this file.

Add minimal styles to `src/renderer/src/styles/ide.css` (near the other dock styles):

```css
.hive-banner { padding: 6px 10px; font: 11px/1.4 var(--font-ui); color: var(--fg-3); border-bottom: 1px solid var(--border-subtle); background: var(--bg-base); }
.hive-connect-btn { color: var(--accent-text); background: transparent; border: none; cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
```

- [ ] **Step 4: Drop the ribbon on the BottomPanel manager-log tab**

In `src/renderer/src/components/BottomPanel.tsx`, remove `<MockDataRibbon />` (~line 146) and its import. (The manager-log is now live; Problems stays seed-driven but the ribbon was panel-wide — if it must stay for Problems, gate it to `tab === 'problems'` instead of removing. Prefer removing it from the `terminal`/`log` paths and keeping it only under `tab === 'problems'`.)

Concretely, replace the unconditional `<MockDataRibbon />` with:

```tsx
        {tab === 'problems' && <MockDataRibbon />}
```

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS (347 existing + the new parse/hiveView tests; no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/AgentDock.tsx src/renderer/src/components/BottomPanel.tsx src/renderer/src/styles/ide.css
git commit -m "feat(hive): wire Dock/BottomPanel to live hive state + connect flow"
```

---

## Task 10: Manual end-to-end verification

**Files:** none (manual). Proves the watcher → reader → IPC → panel round-trip works on real files.

- [ ] **Step 1: Create a fixture workspace**

```bash
mkdir -p /tmp/hivews/.hive/state/{stories,agents,requirements}
cat > /tmp/hivews/.hive/state/stories/STORY-1.md <<'EOF'
---
title: Add /healthz endpoint
status: in-progress
role: intermediate
points: 3
team: api
assigned_to: a1
---
Add a healthz route.
EOF
cat > /tmp/hivews/.hive/state/agents/a1.md <<'EOF'
---
role: intermediate
status: live
team: api
current_story: STORY-1
started_at: 2026-06-03T09:00:00Z
note: writing healthz.ts
---
EOF
printf '%s\n' '{"ts":"2026-06-03T09:01:00Z","actor":"manager","event":"spawned","detail":"STORY-1","level":"ok"}' > /tmp/hivews/.hive/events.ndjson
```

- [ ] **Step 2: Launch + connect**

Run: `npm run dev`. Open/create a project. In the Dock's Run tab, click **Connect…** and pick `/tmp/hivews`.
Expected: the no-workspace banner disappears; the roster shows an "Intermediate · writing healthz.ts" running agent; the Stories tab shows STORY-1 in the **in-progress** column; the bottom manager-log shows `manager: spawned — STORY-1`.

- [ ] **Step 3: Live update**

Externally change the story status:

```bash
sed -i '' 's/status: in-progress/status: review/' /tmp/hivews/.hive/state/stories/STORY-1.md
printf '%s\n' '{"ts":"2026-06-03T09:02:00Z","actor":"senior","event":"review requested","detail":"STORY-1","level":"info"}' >> /tmp/hivews/.hive/events.ndjson
```

Expected (within ~150ms): STORY-1 moves to the **review** column and a new log line appears — no reload.

- [ ] **Step 4: Reconnect after the project re-opens**

Quit and relaunch `npm run dev`. Confirm the project reopens already connected (its `hiveWorkspacePath` persisted) and the board/roster/log repopulate automatically.

- [ ] **Step 5: Bad-file resilience**

```bash
echo 'not valid frontmatter' > /tmp/hivews/.hive/state/stories/BROKEN.md
```

Expected: the board still renders STORY-1 (the broken file is skipped, a warning is logged) — the board does not blank.

- [ ] **Step 6: Record results.** If any step fails, STOP and debug (superpowers:systematic-debugging) before considering the slice complete.

---

## Self-Review Notes

- **Spec coverage:** schema/types (Task 1) ↔ spec §State schema; parsing + aggregation + error handling (Task 2) ↔ §reader + §Error handling; adapter (Task 3) ↔ §Viewer wiring; `hiveWorkspacePath` persistence (Task 4) ↔ §Workspace locator; reader watch/tail/push (Task 5) ↔ §Hive state reader; IPC surface (Task 6) ↔ §reader IPC table; preload bridge (Task 7) ↔ §preload; store+hook (Task 8) + panel wiring/states (Task 9) ↔ §Viewer wiring + states; manual (Task 10) ↔ §Testing manual. Out-of-scope items (supervisor, add-req, QA/merge, chat) remain mock/absent.
- **Type consistency:** `HiveSnapshot`/`HiveConnection`/`HiveSessionBundle`/`HiveEvent` are defined once in `src/types/hive.ts` (Task 1) and consumed unchanged in parse (2), reader (5), handlers (6), preload (7), store/hook (8). The IPC channel strings match across reader (`HIVE_EVENTS`), handlers (`HIVE_CHANNELS`), and preload (`HIVE`). The adapter (`toBoard`/`toRoster`/`toLogLines`) signatures match their call sites in Task 9.
- **No placeholders:** every code step contains complete, runnable content; the two "grep for the exact spot" instructions (Task 4 session threading, Task 9 unused-import cleanup) are mechanical confirmations, with the exact field/value to add specified.
