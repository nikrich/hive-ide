# Hive Native Supervisor — Slice 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Run" button on a hive story spawns one `claude` worker subprocess in an isolated git worktree, streams its output live, lets it edit/test/commit autonomously, reaps it on exit, and writes the story's new state (which the slice-1 watcher renders).

**Architecture:** New main-process area `src/main/hive/run/` with small pure-where-possible units — prompt assembly, state serialize/transitions, a stream-json parser, a worktree wrapper over the existing `GitRunner`, a process-supervising runner with an injected spawn (for tests), and an orchestration/IPC layer. The renderer gets a Run/Stop control per story row; state changes flow back through the existing slice-1 `event:hive:snapshot` watcher, so there is no new render path for the board.

**Tech Stack:** Electron main (Node), TypeScript, `node:child_process`, the `yaml` package (already a dep, used by `src/main/hive/parse.ts`), Vitest (node env for main, happy-dom for renderer), the existing `GitRunner` (`src/main/git/runner.ts`).

**Spec:** `docs/specs/2026-06-05-hive-native-supervisor-slice2a-design.md`

**Conventions:**
- CI runs on **node 22** — verify with `fnm exec --using=22 <cmd>` (fnm has 22.22.2). `tsc -b` is incremental: run `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete` before `npm run typecheck` so stale info can't mask errors.
- Run a single test file with `npx vitest run <path>`; full suite with `npx vitest run`.
- No `any`. Main-process source is `.ts` under `src/main/`; main tests are `*.test.ts` (node env, NOT happy-dom).
- `claude` CLI flags are confirmed available: `-p/--print`, `--append-system-prompt <s>`, `--dangerously-skip-permissions`, `--output-format stream-json`, `--verbose`, `--model <m>`.

---

## File Structure

**Create:**
- `src/main/hive/run/prompt.ts` (+ `.test.ts`) — built-in role prompts + task prompt (pure).
- `src/main/hive/run/serialize.ts` (+ `.test.ts`) — serialize story/agent to frontmatter, build event lines, story-status transition (pure).
- `src/main/hive/run/stream.ts` (+ `.test.ts`) — parse a `claude` stream-json line to a log line (pure).
- `src/main/hive/run/worktree.ts` (+ `.test.ts`) — create/inspect/remove a worktree over `GitRunner`.
- `src/main/hive/run/runner.ts` (+ `.test.ts`) — process supervisor with injected spawn.
- `src/main/hive/run/writer.ts` (+ `.test.ts`) — apply run start/finish to `.hive/state` + `events.ndjson`.
- `src/main/hive/run/handlers.ts` (+ `.test.ts`) — orchestration sequence + IPC registration.

**Modify:**
- `src/types/hive.ts` — add `HiveRunStatus` + `HiveRunStatusEvent` + `HiveRunLogEvent` shared types.
- `src/main/index.ts` — register the run handlers with real deps.
- `src/preload/api.ts` — add `window.hive.run.{start,stop,onLog,onStatus}` to the bridge.
- `src/renderer/src/lib/useHiveSession.ts` (or a new `useHiveRun.ts`) — subscribe to run log/status.
- `src/renderer/src/components/AgentDock.tsx` — Run/Stop control on each Stories-board row.

---

## Task 1: Shared run types

**Files:**
- Modify: `src/types/hive.ts`

- [ ] **Step 1: Add the run event types**

At the end of `src/types/hive.ts`, add:

```ts
// ---------------------------------------------------------------------------
// Slice 2a — worker run (supervisor)
// ---------------------------------------------------------------------------

/** Lifecycle status of a single worker run, pushed to the renderer. */
export type HiveRunStatus = 'starting' | 'running' | 'exited';

/** `event:hive:run:status` payload. */
export interface HiveRunStatusEvent {
  runId: string;
  storyId: string;
  status: HiveRunStatus;
  /** Present when status === 'exited'. */
  outcome?: 'success' | 'no-commit' | 'failure' | 'interrupted';
  /** Optional human-readable detail (e.g. an error message). */
  detail?: string;
}

/** `event:hive:run:log` payload — one rendered log line. */
export interface HiveRunLogEvent {
  runId: string;
  line: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck`
Expected: clean (types are not yet referenced anywhere).

- [ ] **Step 3: Commit**

```bash
git add src/types/hive.ts
git commit -m "feat(hive): shared run-status/log event types (slice 2a)"
```

---

## Task 2: Role + task prompt assembly (pure)

**Files:**
- Create: `src/main/hive/run/prompt.ts`
- Test: `src/main/hive/run/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { BUILTIN_ROLE_PROMPTS, resolveRolePrompt, buildTaskPrompt } from './prompt';
import type { HiveStory } from '../../../types/hive';

function story(over: Partial<HiveStory> = {}): HiveStory {
  return {
    id: 'AUTH-3',
    title: 'Add login form',
    status: 'pending',
    role: 'senior',
    points: 3,
    team: 'web',
    dependsOn: [],
    acceptanceCriteria: ['Form validates email', 'Submits to /login'],
    createdAt: '',
    updatedAt: '',
    body: 'Implement the login form component.',
    ...over,
  };
}

describe('resolveRolePrompt', () => {
  it('uses the workspace override when present', () => {
    expect(resolveRolePrompt('senior', 'OVERRIDE TEXT')).toBe('OVERRIDE TEXT');
  });
  it('falls back to the built-in for the role when no override', () => {
    expect(resolveRolePrompt('qa', null)).toBe(BUILTIN_ROLE_PROMPTS.qa);
  });
  it('has a built-in for every role', () => {
    for (const r of ['manager', 'tech-lead', 'senior', 'intermediate', 'junior', 'qa'] as const) {
      expect(BUILTIN_ROLE_PROMPTS[r].length).toBeGreaterThan(0);
    }
  });
});

describe('buildTaskPrompt', () => {
  const p = buildTaskPrompt(story(), { repoName: 'acme-web', featureBranch: 'feat/AUTH-3' });
  it('includes the story id, title and body', () => {
    expect(p).toContain('AUTH-3');
    expect(p).toContain('Add login form');
    expect(p).toContain('Implement the login form component.');
  });
  it('renders acceptance criteria as a checklist', () => {
    expect(p).toContain('- [ ] Form validates email');
    expect(p).toContain('- [ ] Submits to /login');
  });
  it('states the branch/repo and the commit + test instruction', () => {
    expect(p).toContain('feat/AUTH-3');
    expect(p).toContain('acme-web');
    expect(p.toLowerCase()).toContain('commit');
    expect(p.toLowerCase()).toContain('test');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/prompt.ts`:

```ts
/**
 * Worker prompt assembly (pure) — slice 2a.
 *
 * The role *system* prompt is a minimal built-in per role, overridable by a
 * workspace `.hive/skills/<role>.md`. The *task* prompt is rendered from the
 * story. Both are pure: callers read any override file off disk and pass its
 * contents in.
 */

import type { HiveRole, HiveStory } from '../../../types/hive';

const COMMON = [
  'You are an autonomous engineering agent working inside an isolated git',
  'worktree. You may edit files, run the project test command, and commit.',
  'When the acceptance criteria are met and tests pass, COMMIT your work with a',
  'clear message. Do not push, open PRs, or touch files outside this worktree.',
].join(' ');

/** Minimal built-in system prompt per role. Overridden by a workspace skill. */
export const BUILTIN_ROLE_PROMPTS: Record<HiveRole, string> = {
  manager: `${COMMON} Act as an engineering manager: keep scope tight and unblock the task.`,
  'tech-lead': `${COMMON} Act as a tech lead: prefer the smallest correct change that fits existing patterns.`,
  senior: `${COMMON} Act as a senior engineer: write clean, well-tested, idiomatic code.`,
  intermediate: `${COMMON} Act as an intermediate engineer: follow existing patterns closely and add tests.`,
  junior: `${COMMON} Act as a junior engineer: make the focused change requested and add a test.`,
  qa: `${COMMON} Act as QA: verify behaviour with tests and harden edge cases.`,
};

/** Override file contents win; otherwise the built-in for the role. */
export function resolveRolePrompt(role: HiveRole, workspaceSkill: string | null): string {
  return workspaceSkill ?? BUILTIN_ROLE_PROMPTS[role];
}

/** Render the worker's task from a story. */
export function buildTaskPrompt(
  story: HiveStory,
  ctx: { repoName: string; featureBranch: string },
): string {
  const criteria =
    story.acceptanceCriteria.length > 0
      ? story.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')
      : '- [ ] (no acceptance criteria specified)';
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
  ].join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/prompt.ts src/main/hive/run/prompt.test.ts
git commit -m "feat(hive): worker role + task prompt assembly (slice 2a)"
```

---

## Task 3: State serialize + status transition (pure)

**Files:**
- Create: `src/main/hive/run/serialize.ts`
- Test: `src/main/hive/run/serialize.test.ts`

Background: `src/main/hive/parse.ts` parses frontmatter using snake_case keys —
story: `status,title,role,points,team,assigned_to,feature_branch,depends_on,acceptance_criteria,parent_requirement,pr_url,created_at,updated_at,merged_at`;
agent: `status,role,team,current_story,worktree,pid,started_at,ended_at,note`.
Serialize must emit those keys so `parse(serialize(x))` round-trips. Use the
`yaml` package (already used by `parse.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/serialize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { serializeStory, serializeAgent, eventLine, nextStoryStatus } from './serialize';
import { parseStory, parseAgent, parseEventLine } from '../parse';
import type { HiveAgent, HiveStory, HiveEvent } from '../../../types/hive';

function story(over: Partial<HiveStory> = {}): HiveStory {
  return {
    id: 'AUTH-3', title: 'Add login form', status: 'in-progress', role: 'senior',
    points: 3, team: 'web', assignedTo: 'run_1', featureBranch: 'feat/AUTH-3',
    dependsOn: ['AUTH-1'], acceptanceCriteria: ['a', 'b'], parentRequirement: 'REQ-1',
    createdAt: '2026-06-05T00:00:00Z', updatedAt: '2026-06-05T01:00:00Z',
    body: 'Implement login.', ...over,
  };
}
function agent(over: Partial<HiveAgent> = {}): HiveAgent {
  return {
    id: 'run_1', role: 'senior', status: 'live', team: 'web', currentStory: 'AUTH-3',
    worktree: '.hive/worktrees/AUTH-3', pid: 4242, startedAt: '2026-06-05T00:00:00Z',
    note: 'working', ...over,
  };
}

describe('serializeStory round-trips through parseStory', () => {
  it('preserves the written fields', () => {
    const s = story();
    expect(parseStory(serializeStory(s), s.id)).toEqual(s);
  });
});

describe('serializeAgent round-trips through parseAgent', () => {
  it('preserves the written fields', () => {
    const a = agent();
    expect(parseAgent(serializeAgent(a), a.id)).toEqual(a);
  });
});

describe('eventLine round-trips through parseEventLine', () => {
  it('preserves an event', () => {
    const ev: HiveEvent = {
      ts: '2026-06-05T00:00:00Z', actor: 'run_1', event: 'started',
      detail: 'AUTH-3', level: 'info',
    };
    expect(parseEventLine(eventLine(ev))).toEqual(ev);
  });
});

describe('nextStoryStatus', () => {
  it('success → review', () => expect(nextStoryStatus({ kind: 'success' })).toBe('review'));
  it('no-commit → blocked', () => expect(nextStoryStatus({ kind: 'no-commit' })).toBe('blocked'));
  it('failure → blocked', () => expect(nextStoryStatus({ kind: 'failure' })).toBe('blocked'));
  it('interrupted → pending', () => expect(nextStoryStatus({ kind: 'interrupted' })).toBe('pending'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/serialize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

First confirm `parseEventLine`'s shape by reading `src/main/hive/parse.ts:153` — it
parses one JSON object per line with keys `ts, actor, event, detail, level`. Then
create `src/main/hive/run/serialize.ts`:

```ts
/**
 * Serialize hive entities back to the slice-1 on-disk format (pure) — slice 2a.
 *
 * Emits the same snake_case frontmatter keys `parse.ts` reads, so
 * `parse(serialize(x))` round-trips. Optional fields are omitted when absent
 * (parse treats absent === undefined).
 */

import { stringify } from 'yaml';

import type { HiveAgent, HiveEvent, HiveStory, StoryStatus } from '../../../types/hive';

function frontmatter(data: Record<string, unknown>, body: string): string {
  // Drop undefined so absent optionals aren't written as `key: null`.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringify(clean).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

export function serializeStory(s: HiveStory): string {
  return frontmatter(
    {
      status: s.status,
      title: s.title,
      role: s.role,
      points: s.points,
      team: s.team,
      assigned_to: s.assignedTo,
      feature_branch: s.featureBranch,
      depends_on: s.dependsOn,
      acceptance_criteria: s.acceptanceCriteria,
      parent_requirement: s.parentRequirement,
      pr_url: s.prUrl,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      merged_at: s.mergedAt,
    },
    s.body,
  );
}

export function serializeAgent(a: HiveAgent): string {
  // Agents carry no markdown body in slice 1 (parseAgent ignores it).
  return frontmatter(
    {
      status: a.status,
      role: a.role,
      team: a.team,
      current_story: a.currentStory,
      worktree: a.worktree,
      pid: a.pid,
      started_at: a.startedAt,
      ended_at: a.endedAt,
      note: a.note,
    },
    '',
  );
}

/** One `events.ndjson` line. */
export function eventLine(ev: HiveEvent): string {
  return JSON.stringify({
    ts: ev.ts,
    actor: ev.actor,
    event: ev.event,
    detail: ev.detail,
    level: ev.level,
  });
}

/** Story status after a finished run. */
export function nextStoryStatus(
  outcome:
    | { kind: 'success' }
    | { kind: 'no-commit' }
    | { kind: 'failure' }
    | { kind: 'interrupted' },
): StoryStatus {
  switch (outcome.kind) {
    case 'success':
      return 'review';
    case 'no-commit':
    case 'failure':
      return 'blocked';
    case 'interrupted':
      return 'pending';
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/serialize.test.ts`
Expected: PASS. If a round-trip fails because `parse.ts` defaults a field you
didn't write (e.g. `team: ''`), ensure the test fixture sets that field (it does)
— do NOT change `parse.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/serialize.ts src/main/hive/run/serialize.test.ts
git commit -m "feat(hive): serialize story/agent/event + status transition (slice 2a)"
```

---

## Task 4: Claude stream-json parser (pure)

**Files:**
- Create: `src/main/hive/run/stream.ts`
- Test: `src/main/hive/run/stream.test.ts`

Background: `claude -p --output-format stream-json --verbose` emits NDJSON, one
JSON object per line. Object shapes (confirm against a real sample during
implementation; the parser must be tolerant of unknown shapes):
- `{ "type": "system", "subtype": "init", ... }`
- `{ "type": "assistant", "message": { "content": [ { "type": "text", "text": "…" }, { "type": "tool_use", "name": "Bash", "input": { … } } ] } }`
- `{ "type": "user", "message": { "content": [ { "type": "tool_result", … } ] } }`
- `{ "type": "result", "subtype": "success" | "error_*", "is_error": false, "result": "…", "total_cost_usd": 0.01 }`

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { parseClaudeStreamLine } from './stream';

describe('parseClaudeStreamLine', () => {
  it('returns null for a blank line', () => {
    expect(parseClaudeStreamLine('')).toBeNull();
    expect(parseClaudeStreamLine('   ')).toBeNull();
  });

  it('returns null for a non-JSON line (tolerated)', () => {
    expect(parseClaudeStreamLine('not json')).toBeNull();
  });

  it('renders assistant text content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Editing the form' }] },
    });
    expect(parseClaudeStreamLine(line)).toBe('Editing the form');
  });

  it('renders a tool_use as an arrow line with the tool name', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    });
    expect(parseClaudeStreamLine(line)).toBe('→ Bash: npm test');
  });

  it('renders a successful result', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    expect(parseClaudeStreamLine(line)).toContain('✓');
  });

  it('renders an error result', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(parseClaudeStreamLine(line)).toContain('✗');
  });

  it('returns null for an init/system line', () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/stream.ts`:

```ts
/**
 * Parse one `claude -p --output-format stream-json` NDJSON line into a single
 * human-readable log line, or null to skip (blank/system/unknown/malformed).
 * Pure + defensive — a bad line must never throw.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function briefInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  const first = Object.values(input).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first : '';
}

export function parseClaudeStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = ev.type;
  if (type === 'assistant') {
    const message = ev.message as { content?: ContentBlock[] } | undefined;
    const blocks = message?.content ?? [];
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
        parts.push(b.text.trim());
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const arg = briefInput(b.input);
        parts.push(`→ ${b.name}${arg ? `: ${arg}` : ''}`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (type === 'result') {
    const isError = ev.is_error === true;
    const result = typeof ev.result === 'string' ? ev.result : '';
    return isError ? `✗ run failed${result ? `: ${result}` : ''}` : `✓ ${result || 'done'}`;
  }

  // system / user(tool_result) / unknown → skip.
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/stream.ts src/main/hive/run/stream.test.ts
git commit -m "feat(hive): claude stream-json line parser (slice 2a)"
```

---

## Task 5: Worktree manager

**Files:**
- Create: `src/main/hive/run/worktree.ts`
- Test: `src/main/hive/run/worktree.test.ts`

Background: `GitRunner.run(cwd, args, opts) → { stdout, stderr, code }`. Non-zero
exit resolves with `code`; ENOENT rejects. We inject a runner so tests assert the
git commands without a real repo.

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/worktree.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

import { createWorktree, hasNewCommit, type GitLike } from './worktree';

function fakeGit(map: Record<string, { stdout: string; code: number }>): GitLike {
  return {
    run: vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(' ');
      const hit = Object.entries(map).find(([k]) => key.startsWith(k));
      return hit ? hit[1] : { stdout: '', stderr: '', code: 0 };
    }),
  };
}

describe('createWorktree', () => {
  it('resolves the default branch, captures baseSha, and adds the worktree', async () => {
    const git = fakeGit({
      'symbolic-ref': { stdout: 'main\n', code: 0 },
      'rev-parse': { stdout: 'abc123\n', code: 0 },
      'worktree add': { stdout: '', code: 0 },
    });
    const wt = await createWorktree({
      git, repoPath: '/repo', workspacePath: '/ws', storyId: 'AUTH-3', branch: 'feat/AUTH-3',
    });
    expect(wt.path).toBe('/ws/.hive/worktrees/AUTH-3');
    expect(wt.branch).toBe('feat/AUTH-3');
    expect(wt.baseSha).toBe('abc123');
    expect(git.run).toHaveBeenCalledWith(
      '/repo',
      expect.arrayContaining(['worktree', 'add', '-b', 'feat/AUTH-3', '/ws/.hive/worktrees/AUTH-3', 'abc123']),
    );
  });
});

describe('hasNewCommit', () => {
  it('true when rev-list count > 0', async () => {
    const git = fakeGit({ 'rev-list': { stdout: '2\n', code: 0 } });
    expect(await hasNewCommit({ git, path: '/wt', branch: 'b', baseSha: 'abc' })).toBe(true);
  });
  it('false when rev-list count is 0', async () => {
    const git = fakeGit({ 'rev-list': { stdout: '0\n', code: 0 } });
    expect(await hasNewCommit({ git, path: '/wt', branch: 'b', baseSha: 'abc' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/worktree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/worktree.ts`:

```ts
/**
 * Git worktree lifecycle for a worker run (slice 2a). Thin wrapper over a
 * GitRunner-shaped dependency so it's testable without a real repo.
 */

import { join } from 'node:path';

/** The slice of GitRunner we use (injected for tests). */
export interface GitLike {
  run(
    cwd: string,
    args: string[],
    opts?: { maxBufferMB?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface Worktree {
  /** GitLike used to operate on this worktree. */
  git: GitLike;
  /** Absolute worktree path. */
  path: string;
  branch: string;
  /** Default-branch sha the worktree was cut from (commit-detection base). */
  baseSha: string;
}

/** Resolve the repo's default branch name (e.g. `main`). */
async function defaultBranch(git: GitLike, repoPath: string): Promise<string> {
  // `git symbolic-ref --short HEAD` gives the current branch; for a clean repo
  // that's the default. Fall back to `main` if detached/empty.
  const res = await git.run(repoPath, ['symbolic-ref', '--short', 'HEAD']);
  const name = res.stdout.trim();
  return name !== '' ? name : 'main';
}

export async function createWorktree(opts: {
  git: GitLike;
  repoPath: string;
  workspacePath: string;
  storyId: string;
  branch: string;
}): Promise<Worktree> {
  const { git, repoPath, workspacePath, storyId, branch } = opts;
  const base = await defaultBranch(git, repoPath);
  const shaRes = await git.run(repoPath, ['rev-parse', base]);
  const baseSha = shaRes.stdout.trim();
  const path = join(workspacePath, '.hive', 'worktrees', storyId);
  const add = await git.run(repoPath, ['worktree', 'add', '-b', branch, path, baseSha]);
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr.trim() || `exit ${add.code}`}`);
  }
  return { git, path, branch, baseSha };
}

/** True if the worktree has ≥1 commit beyond baseSha. */
export async function hasNewCommit(wt: Worktree): Promise<boolean> {
  const res = await wt.git.run(wt.path, ['rev-list', '--count', `${wt.baseSha}..HEAD`]);
  return (parseInt(res.stdout.trim(), 10) || 0) > 0;
}

/** Remove the worktree dir (branch retained). Not used by 2a; exported for later. */
export async function removeWorktree(wt: Worktree): Promise<void> {
  await wt.git.run(wt.path, ['worktree', 'remove', '--force', wt.path]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/worktree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/worktree.ts src/main/hive/run/worktree.test.ts
git commit -m "feat(hive): worktree create/inspect for worker runs (slice 2a)"
```

---

## Task 6: Process-supervising runner

**Files:**
- Create: `src/main/hive/run/runner.ts`
- Test: `src/main/hive/run/runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/runner.test.ts`. Uses a fake child (an `EventEmitter`
with `stdout`/`stderr` emitters + a `kill` spy) so no real `claude` runs.

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { createRunner, type RunSpec, type SpawnFn } from './runner';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 4242;
  return child;
}

const spec: RunSpec = {
  runId: 'run_1', storyId: 'AUTH-3', role: 'senior', cwd: '/wt',
  taskPrompt: 'do it', systemPrompt: 'be senior',
};

describe('createRunner', () => {
  it('streams parsed log lines and reports exit', () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child);
    const runner = createRunner(spawnFn);
    const logs: string[] = [];
    const statuses: string[] = [];
    let exit: { code: number | null } | null = null;
    runner.start(spec, {
      onLog: (l) => logs.push(l),
      onStatus: (s) => statuses.push(s),
      onExit: (r) => { exit = r; },
    });
    expect(runner.isBusy()).toBe(true);
    child.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n',
    ));
    child.emit('exit', 0, null);
    expect(logs).toContain('hi');
    expect(statuses).toContain('running');
    expect(statuses).toContain('exited');
    expect(exit).toEqual({ code: 0, signal: null });
    expect(runner.isBusy()).toBe(false);
  });

  it('rejects a second start while busy', () => {
    const spawnFn: SpawnFn = vi.fn(() => fakeChild());
    const runner = createRunner(spawnFn);
    runner.start(spec, { onLog: () => {}, onStatus: () => {}, onExit: () => {} });
    expect(() => runner.start(spec, { onLog: () => {}, onStatus: () => {}, onExit: () => {} })).toThrow(/busy/i);
  });

  it('stop() sends SIGTERM to the child', async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child);
    const runner = createRunner(spawnFn);
    runner.start(spec, { onLog: () => {}, onStatus: () => {}, onExit: () => {} });
    const p = runner.stop('run_1');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    await p;
  });

  it('passes the expected claude args + cwd to spawn', () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const runner = createRunner(spawnFn);
    runner.start(spec, { onLog: () => {}, onStatus: () => {}, onExit: () => {} });
    const [cmd, args, opts] = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual(expect.arrayContaining([
      '-p', 'do it', '--append-system-prompt', 'be senior',
      '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose',
    ]));
    expect(opts.cwd).toBe('/wt');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/runner.ts`:

```ts
/**
 * Worker process supervisor (slice 2a). Spawns `claude` headless, streams its
 * stream-json output as log lines, and reaps it. One run at a time. The spawn
 * function is injected so tests run without a real `claude`.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import type { HiveRole, HiveRunStatus } from '../../../types/hive';
import { parseClaudeStreamLine } from './stream';

export interface RunSpec {
  runId: string;
  storyId: string;
  role: HiveRole;
  cwd: string;
  taskPrompt: string;
  systemPrompt: string;
  /** Extra env. Defaults to process.env (inherits the user's claude auth). */
  env?: NodeJS.ProcessEnv;
  /** Optional model override. */
  model?: string;
}

export interface RunnerEvents {
  onLog: (line: string) => void;
  onStatus: (s: HiveRunStatus) => void;
  onExit: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface Runner {
  start(spec: RunSpec, events: RunnerEvents): void;
  stop(runId: string): Promise<void>;
  isBusy(): boolean;
}

/** Grace before SIGKILL after SIGTERM. */
const KILL_GRACE_MS = 5000;

export function buildClaudeArgs(spec: RunSpec): string[] {
  const args = [
    '-p', spec.taskPrompt,
    '--append-system-prompt', spec.systemPrompt,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (spec.model) args.push('--model', spec.model);
  return args;
}

export function createRunner(spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn): Runner {
  let active: { runId: string; child: ChildProcess } | null = null;

  return {
    isBusy: () => active !== null,

    start(spec, events) {
      if (active !== null) throw new Error('runner is busy: a run is already active');
      events.onStatus('starting');
      const child = spawnFn('claude', buildClaudeArgs(spec), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
      });
      active = { runId: spec.runId, child };
      events.onStatus('running');

      let buf = '';
      const onChunk = (chunk: Buffer | string): void => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const rendered = parseClaudeStreamLine(line);
          if (rendered !== null) events.onLog(rendered);
        }
      };
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', (c: Buffer | string) => {
        const s = c.toString().trim();
        if (s !== '') events.onLog(s);
      });

      child.on('error', (err: Error) => {
        events.onLog(`spawn error: ${err.message}`);
      });
      child.on('exit', (code, signal) => {
        active = null;
        events.onStatus('exited');
        events.onExit({ code, signal });
      });
    },

    stop(runId) {
      return new Promise<void>((resolve) => {
        if (active === null || active.runId !== runId) {
          resolve();
          return;
        }
        const { child } = active;
        const done = (): void => resolve();
        child.once('exit', done);
        child.kill('SIGTERM');
        setTimeout(() => {
          if (active !== null && active.runId === runId) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
      });
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/runner.ts src/main/hive/run/runner.test.ts
git commit -m "feat(hive): worker process supervisor with injected spawn (slice 2a)"
```

---

## Task 7: State writer (.hive/state + events.ndjson)

**Files:**
- Create: `src/main/hive/run/writer.ts`
- Test: `src/main/hive/run/writer.test.ts`

Writers do real fs; tested against a temp dir with `node:fs/promises` + `os.tmpdir()`.

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/writer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeRunStart, writeRunFinish } from './writer';
import { serializeStory } from './serialize';
import { parseStory, parseAgent } from '../parse';
import type { HiveStory } from '../../../types/hive';

let ws: string;
const story: HiveStory = {
  id: 'AUTH-3', title: 'Add login', status: 'pending', role: 'senior', points: 3,
  team: 'web', dependsOn: [], acceptanceCriteria: ['a'], createdAt: 't', updatedAt: 't',
  body: 'do it',
};

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'hivews-'));
  await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
  await mkdir(join(ws, '.hive', 'state', 'agents'), { recursive: true });
  await writeFile(join(ws, '.hive', 'state', 'stories', 'AUTH-3.md'), serializeStory(story));
});
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe('writeRunStart', () => {
  it('sets the story in-progress, writes the agent live, appends a started event', async () => {
    await writeRunStart({
      workspacePath: ws, story, runId: 'run_1', featureBranch: 'feat/AUTH-3',
      worktree: '.hive/worktrees/AUTH-3', pid: 4242, now: '2026-06-05T00:00:00Z',
    });
    const s = parseStory(await readFile(join(ws, '.hive/state/stories/AUTH-3.md'), 'utf8'), 'AUTH-3');
    expect(s.status).toBe('in-progress');
    expect(s.assignedTo).toBe('run_1');
    expect(s.featureBranch).toBe('feat/AUTH-3');
    const a = parseAgent(await readFile(join(ws, '.hive/state/agents/run_1.md'), 'utf8'), 'run_1');
    expect(a.status).toBe('live');
    expect(a.currentStory).toBe('AUTH-3');
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"started"');
  });
});

describe('writeRunFinish', () => {
  it('success → story review, agent exited, finished event', async () => {
    await writeRunStart({
      workspacePath: ws, story, runId: 'run_1', featureBranch: 'feat/AUTH-3',
      worktree: '.hive/worktrees/AUTH-3', pid: 4242, now: 't0',
    });
    await writeRunFinish({
      workspacePath: ws, storyId: 'AUTH-3', runId: 'run_1',
      outcome: { kind: 'success' }, now: '2026-06-05T01:00:00Z',
    });
    const s = parseStory(await readFile(join(ws, '.hive/state/stories/AUTH-3.md'), 'utf8'), 'AUTH-3');
    expect(s.status).toBe('review');
    const a = parseAgent(await readFile(join(ws, '.hive/state/agents/run_1.md'), 'utf8'), 'run_1');
    expect(a.status).toBe('exited');
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"finished"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/writer.ts`:

```ts
/**
 * Apply a worker run's start/finish to the slice-1 file store (slice 2a).
 * Reads the current story, mutates it + the agent record, appends events.
 * Best-effort: callers wrap in try/catch; a failed write must not crash main.
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HiveAgent, HiveEvent, HiveStory } from '../../../types/hive';
import { parseStory } from '../parse';
import { serializeStory, serializeAgent, eventLine, nextStoryStatus } from './serialize';

function storyPath(ws: string, id: string): string {
  return join(ws, '.hive', 'state', 'stories', `${id}.md`);
}
function agentPath(ws: string, id: string): string {
  return join(ws, '.hive', 'state', 'agents', `${id}.md`);
}
function eventsPath(ws: string): string {
  return join(ws, '.hive', 'events.ndjson');
}

async function appendEvent(ws: string, ev: HiveEvent): Promise<void> {
  await appendFile(eventsPath(ws), eventLine(ev) + '\n', 'utf8');
}

export async function writeRunStart(opts: {
  workspacePath: string;
  story: HiveStory;
  runId: string;
  featureBranch: string;
  worktree: string;
  pid: number | undefined;
  now: string;
}): Promise<void> {
  const { workspacePath: ws, story, runId, featureBranch, worktree, pid, now } = opts;
  const updated: HiveStory = {
    ...story,
    status: 'in-progress',
    assignedTo: runId,
    featureBranch,
    updatedAt: now,
  };
  await writeFile(storyPath(ws, story.id), serializeStory(updated), 'utf8');

  const agent: HiveAgent = {
    id: runId,
    role: story.role,
    status: 'live',
    team: story.team,
    currentStory: story.id,
    worktree,
    pid,
    startedAt: now,
    note: `running ${story.id}`,
  };
  await writeFile(agentPath(ws, runId), serializeAgent(agent), 'utf8');

  await appendEvent(ws, {
    ts: now, actor: runId, event: 'started', detail: story.id, level: 'info',
  });
}

export async function writeRunFinish(opts: {
  workspacePath: string;
  storyId: string;
  runId: string;
  outcome: { kind: 'success' } | { kind: 'no-commit' } | { kind: 'failure' } | { kind: 'interrupted' };
  now: string;
}): Promise<void> {
  const { workspacePath: ws, storyId, runId, outcome, now } = opts;

  // Re-read the story so we don't clobber any field changed meanwhile.
  const current = parseStory(await readFile(storyPath(ws, storyId), 'utf8'), storyId);
  const updated: HiveStory = {
    ...current,
    status: nextStoryStatus(outcome),
    updatedAt: now,
  };
  await writeFile(storyPath(ws, storyId), serializeStory(updated), 'utf8');

  // Update the agent record to exited.
  const note =
    outcome.kind === 'success' ? 'completed'
    : outcome.kind === 'no-commit' ? 'no changes produced'
    : outcome.kind === 'interrupted' ? 'stopped'
    : 'failed';
  const agent: HiveAgent = {
    id: runId, role: current.role, status: 'exited', team: current.team,
    currentStory: storyId, startedAt: now, endedAt: now, note,
  };
  await writeFile(agentPath(ws, runId), serializeAgent(agent), 'utf8');

  const level: HiveEvent['level'] = outcome.kind === 'success' ? 'ok' : 'warn';
  const event = outcome.kind === 'success' ? 'finished' : 'failed';
  await appendEvent(ws, { ts: now, actor: runId, event, detail: `${storyId} (${note})`, level });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/writer.ts src/main/hive/run/writer.test.ts
git commit -m "feat(hive): run-state writer (story/agent/events) (slice 2a)"
```

---

## Task 8: Orchestration + IPC handlers

**Files:**
- Create: `src/main/hive/run/handlers.ts`
- Test: `src/main/hive/run/handlers.test.ts`

This composes the units into the run sequence and registers IPC. Read
`src/main/hive/handlers.ts` first to mirror its `registerHiveHandlers(deps)` shape
(a deps object, returns a teardown fn, uses `ipcMain.handle` + a `send` fn). The
orchestration is exposed as a pure-ish `runStory(deps, storyId)` so it's testable
without `ipcMain`.

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/handlers.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

import { runStory, type RunDeps } from './handlers';
import type { HiveStory } from '../../../types/hive';

const story: HiveStory = {
  id: 'AUTH-3', title: 'Add login', status: 'pending', role: 'senior', points: 3,
  team: 'web', dependsOn: [], acceptanceCriteria: ['a'], createdAt: 't', updatedAt: 't',
  body: 'do it',
};

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    getWorkspacePath: () => '/ws',
    getRepoPath: () => '/repo',
    getStory: vi.fn(async () => story),
    readRoleOverride: vi.fn(async () => null),
    createWorktree: vi.fn(async () => ({ git: {} as never, path: '/ws/.hive/worktrees/AUTH-3', branch: 'feat/AUTH-3', baseSha: 'abc' })),
    hasNewCommit: vi.fn(async () => true),
    writeRunStart: vi.fn(async () => {}),
    writeRunFinish: vi.fn(async () => {}),
    runner: {
      isBusy: () => false,
      start: vi.fn((_spec, ev) => { ev.onStatus('running'); ev.onExit({ code: 0, signal: null }); }),
      stop: vi.fn(async () => {}),
    },
    send: vi.fn(),
    appendRunLog: vi.fn(),
    now: () => 't0',
    newRunId: () => 'run_1',
    ...over,
  };
}

describe('runStory', () => {
  it('runs the happy path: worktree → start-write → runner → commit → finish(success)', async () => {
    const d = deps();
    await runStory(d, 'AUTH-3');
    expect(d.createWorktree).toHaveBeenCalled();
    expect(d.writeRunStart).toHaveBeenCalled();
    expect(d.runner.start).toHaveBeenCalled();
    expect(d.hasNewCommit).toHaveBeenCalled();
    expect(d.writeRunFinish).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: 'success' } }));
  });

  it('exit 0 with no commit → finish(no-commit)', async () => {
    const d = deps({ hasNewCommit: vi.fn(async () => false) });
    await runStory(d, 'AUTH-3');
    expect(d.writeRunFinish).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: 'no-commit' } }));
  });

  it('non-zero exit → finish(failure)', async () => {
    const d = deps({
      runner: {
        isBusy: () => false,
        start: vi.fn((_spec, ev) => { ev.onStatus('running'); ev.onExit({ code: 1, signal: null }); }),
        stop: vi.fn(async () => {}),
      },
    });
    await runStory(d, 'AUTH-3');
    expect(d.writeRunFinish).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: 'failure' } }));
  });

  it('throws when the runner is busy', async () => {
    const d = deps({ runner: { isBusy: () => true, start: vi.fn(), stop: vi.fn(async () => {}) } });
    await expect(runStory(d, 'AUTH-3')).rejects.toThrow(/busy/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/handlers.ts`:

```ts
/**
 * Worker-run orchestration + IPC (slice 2a). `runStory` composes the units into
 * the create-worktree → start-write → spawn → reap → finish-write sequence and
 * is dependency-injected for tests. `registerHiveRunHandlers` wires it to IPC.
 */

import { ipcMain } from 'electron';

import type {
  HiveRole,
  HiveRunStatusEvent,
  HiveRunLogEvent,
  HiveStory,
} from '../../../types/hive';
import { resolveRolePrompt, buildTaskPrompt } from './prompt';
import type { Worktree } from './worktree';
import type { Runner } from './runner';

export const HIVE_RUN_CHANNELS = {
  start: 'ipc:hive:run:start',
  stop: 'ipc:hive:run:stop',
} as const;

export const HIVE_RUN_EVENTS = {
  log: 'event:hive:run:log',
  status: 'event:hive:run:status',
} as const;

type Outcome =
  | { kind: 'success' } | { kind: 'no-commit' } | { kind: 'failure' } | { kind: 'interrupted' };

export interface RunDeps {
  getWorkspacePath: () => string | null;
  getRepoPath: () => string | null;
  getStory: (storyId: string) => Promise<HiveStory | null>;
  /** Contents of <ws>/.hive/skills/<role>.md, or null. */
  readRoleOverride: (role: HiveRole) => Promise<string | null>;
  createWorktree: (opts: {
    repoPath: string; workspacePath: string; storyId: string; branch: string;
  }) => Promise<Worktree>;
  hasNewCommit: (wt: Worktree) => Promise<boolean>;
  writeRunStart: (opts: {
    workspacePath: string; story: HiveStory; runId: string; featureBranch: string;
    worktree: string; pid: number | undefined; now: string;
  }) => Promise<void>;
  writeRunFinish: (opts: {
    workspacePath: string; storyId: string; runId: string; outcome: Outcome; now: string;
  }) => Promise<void>;
  runner: Runner;
  send: (channel: string, payload: HiveRunLogEvent | HiveRunStatusEvent) => void;
  /** Best-effort append of a rendered log line to the per-run log file. */
  appendRunLog: (runId: string, line: string) => void;
  now: () => string;
  newRunId: () => string;
}

export async function runStory(deps: RunDeps, storyId: string): Promise<{ runId: string }> {
  if (deps.runner.isBusy()) throw new Error('A run is already active (runner busy)');
  const workspacePath = deps.getWorkspacePath();
  const repoPath = deps.getRepoPath();
  if (!workspacePath || !repoPath) throw new Error('No connected hive workspace / repo');

  const story = await deps.getStory(storyId);
  if (!story) throw new Error(`Story not found: ${storyId}`);

  const runId = deps.newRunId();
  const branch = story.featureBranch ?? `feat/${storyId}`;

  const wt = await deps.createWorktree({ repoPath, workspacePath, storyId, branch });

  await deps.writeRunStart({
    workspacePath, story, runId, featureBranch: branch,
    worktree: wt.path, pid: undefined, now: deps.now(),
  });

  const systemPrompt = resolveRolePrompt(story.role, await deps.readRoleOverride(story.role));
  const taskPrompt = buildTaskPrompt(story, { repoName: story.team, featureBranch: branch });

  const status = (s: HiveRunStatusEvent['status'], extra: Partial<HiveRunStatusEvent> = {}): void =>
    deps.send(HIVE_RUN_EVENTS.status, { runId, storyId, status: s, ...extra });

  await new Promise<void>((resolve) => {
    deps.runner.start(
      { runId, storyId, role: story.role, cwd: wt.path, taskPrompt, systemPrompt },
      {
        onLog: (line) => {
          deps.send(HIVE_RUN_EVENTS.log, { runId, line });
          deps.appendRunLog(runId, line);
        },
        onStatus: (s) => status(s),
        onExit: (result) => {
          void (async () => {
            let outcome: Outcome;
            if (result.signal !== null) outcome = { kind: 'interrupted' };
            else if (result.code === 0) outcome = (await deps.hasNewCommit(wt)) ? { kind: 'success' } : { kind: 'no-commit' };
            else outcome = { kind: 'failure' };
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
      },
    );
  });

  return { runId };
}

export function registerHiveRunHandlers(deps: RunDeps): () => void {
  ipcMain.handle(HIVE_RUN_CHANNELS.start, (_e, args: { storyId: string }) =>
    runStory(deps, args.storyId),
  );
  ipcMain.handle(HIVE_RUN_CHANNELS.stop, (_e, args: { runId: string }) =>
    deps.runner.stop(args.runId),
  );
  return () => {
    ipcMain.removeHandler(HIVE_RUN_CHANNELS.start);
    ipcMain.removeHandler(HIVE_RUN_CHANNELS.stop);
  };
}
```

Note: `runStory` awaits the whole run before resolving the `ipc:hive:run:start`
invoke. That's fine — the renderer doesn't block on it (it `void`s the call and
listens for `event:hive:run:status`). If you prefer the invoke to return `runId`
immediately, resolve after `writeRunStart` and detach the run; for 2a awaiting is
simpler and the busy-guard still protects against overlap.

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/handlers.ts src/main/hive/run/handlers.test.ts
git commit -m "feat(hive): worker-run orchestration + IPC handlers (slice 2a)"
```

---

## Task 9: Wire run handlers into the main process

**Files:**
- Modify: `src/main/index.ts`

No new unit test (integration wiring); verified by typecheck + the manual e2e in
Task 12. Read how `registerHiveHandlers` / the `hiveReader` are constructed in
`index.ts` and mirror it — reuse the same `send` mechanism (the `(channel,
payload) => win.webContents.send(channel, payload)` the reader uses) and the same
active-project/workspace source.

- [ ] **Step 1: Build the real deps + register**

In `src/main/index.ts`, where the other hive handlers are registered, add the run
handlers. Use the existing `GitRunner`, the slice-1 reader's notion of the active
workspace path, and a `send` over the main window. Concretely:

```ts
import { GitRunner } from './git/runner';
import { registerHiveRunHandlers } from './hive/run/handlers';
import { createRunner } from './hive/run/runner';
import { createWorktree as createWt, hasNewCommit as hasCommit } from './hive/run/worktree';
import { writeRunStart, writeRunFinish } from './hive/run/writer';
import { parseStory } from './hive/parse';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// …inside app setup, after the slice-1 hive handlers/reader are wired and the
// window exists. `send` mirrors the reader's sender; `activeWorkspacePath()` and
// `activeRepoPath()` come from wherever slice-1 tracks the connected workspace +
// the active project's first repo (read the existing code and reuse it).
const gitRunner = new GitRunner();
const runner = createRunner();
const send = (channel: string, payload: unknown): void => {
  mainWindow?.webContents.send(channel, payload);
};

registerHiveRunHandlers({
  getWorkspacePath: () => activeWorkspacePath(),
  getRepoPath: () => activeRepoPath(),
  getStory: async (storyId) => {
    const ws = activeWorkspacePath();
    if (!ws) return null;
    try {
      const raw = await readFile(join(ws, '.hive', 'state', 'stories', `${storyId}.md`), 'utf8');
      return parseStory(raw, storyId);
    } catch {
      return null;
    }
  },
  readRoleOverride: async (role) => {
    const ws = activeWorkspacePath();
    if (!ws) return null;
    try {
      return await readFile(join(ws, '.hive', 'skills', `${role}.md`), 'utf8');
    } catch {
      return null;
    }
  },
  createWorktree: (o) => createWt({ git: gitRunner, ...o }),
  hasNewCommit: (wt) => hasCommit(wt),
  writeRunStart,
  writeRunFinish,
  runner,
  send: send as never,
  appendRunLog: (runId, line) => {
    const ws = activeWorkspacePath();
    if (!ws) return;
    const dir = join(ws, '.hive', 'logs');
    // Best-effort, fire-and-forget; never block or throw into the run loop.
    void mkdir(dir, { recursive: true })
      .then(() => appendFile(join(dir, `${runId}.log`), line + '\n', 'utf8'))
      .catch(() => undefined);
  },
  now: () => new Date().toISOString(),
  newRunId: () => `run_${randomUUID().slice(0, 8)}`,
});
```

IMPORTANT — `activeWorkspacePath()` / `activeRepoPath()`: do NOT invent these.
Read `index.ts` + `src/main/hive/reader.ts` + `src/main/hive/handlers.ts` to find
how the connected workspace path and the active project's repo are already
tracked, and call that. If only the workspace path is tracked (not a repo path),
derive the repo path from the project's first repo via the existing
`PersistedStateStore` / project state the main process already holds. Wire to the
real source; the deps shape above is the contract.

- [ ] **Step 2: Reap on quit**

In the existing `app.on('before-quit')` / window-close teardown, call
`void runner.stop(/* active run id */)`. Since 2a tracks a single active run, the
simplest is to expose the active runId from the runner or capture it where
`runStory` is invoked; for the wiring, add a module-level `let activeRunId` set in
the `start` handler and cleared on exit, and `if (activeRunId) void runner.stop(activeRunId)`
in teardown. (The runner's `stop` no-ops if nothing is active.)

- [ ] **Step 3: Typecheck**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(hive): register worker-run handlers in main (slice 2a)"
```

---

## Task 10: Preload bridge

**Files:**
- Modify: `src/preload/api.ts`

Read the existing `window.hive.orchestration` bridge in `api.ts` and mirror its
style (channel constants, `ipcRenderer.invoke`, `ipcRenderer.on` + an unsubscribe
returner).

- [ ] **Step 1: Add the run bridge**

Add a `run` section to the `window.hive` bridge:

```ts
// types
export type HiveRunStatusHandler = (e: import('../types/hive').HiveRunStatusEvent) => void;
export type HiveRunLogHandler = (e: import('../types/hive').HiveRunLogEvent) => void;

// inside the hive bridge object:
run: {
  start(storyId: string): Promise<{ runId: string }> {
    return ipcRenderer.invoke('ipc:hive:run:start', { storyId });
  },
  stop(runId: string): Promise<void> {
    return ipcRenderer.invoke('ipc:hive:run:stop', { runId });
  },
  onStatus(handler: HiveRunStatusHandler): () => void {
    const fn = (_e: unknown, payload: import('../types/hive').HiveRunStatusEvent): void => handler(payload);
    ipcRenderer.on('event:hive:run:status', fn);
    return () => ipcRenderer.removeListener('event:hive:run:status', fn);
  },
  onLog(handler: HiveRunLogHandler): () => void {
    const fn = (_e: unknown, payload: import('../types/hive').HiveRunLogEvent): void => handler(payload);
    ipcRenderer.on('event:hive:run:log', fn);
    return () => ipcRenderer.removeListener('event:hive:run:log', fn);
  },
},
```

Add the matching types to the bridge's exported interface (the `HiveBridge` /
whatever the file calls it) so `window.hive.run` is typed in the renderer. Mirror
the exact pattern the existing `orchestration` bridge uses (it already declares
handler types + an interface — extend that interface with `run`).

- [ ] **Step 2: Typecheck**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/preload/api.ts
git commit -m "feat(hive): preload run bridge (window.hive.run) (slice 2a)"
```

---

## Task 11: Renderer — Run/Stop control + live run state

**Files:**
- Create: `src/renderer/src/lib/useHiveRun.ts`
- Modify: `src/renderer/src/components/AgentDock.tsx`

Read `src/renderer/src/lib/useHiveSession.ts` for the subscription pattern (it
sets up `window.hive.orchestration.on*` listeners in an effect and feeds a store).
Read `AgentDock.tsx` to find where Stories-board rows render (the `board` prop /
the `toBoard` output) and add a per-row Run/Stop control.

- [ ] **Step 1: Run subscription hook**

Create `src/renderer/src/lib/useHiveRun.ts`:

```ts
import { useEffect, useState } from 'react';

import type { HiveRunStatusEvent } from '../../../types/hive';

export interface HiveRunState {
  active: HiveRunStatusEvent | null;
  logLines: string[];
}

/**
 * Subscribe to worker-run status + log streams. Returns the active run (if any)
 * and a bounded tail of rendered log lines. Single run at a time (slice 2a).
 */
export function useHiveRun(): HiveRunState & {
  start: (storyId: string) => Promise<void>;
  stop: () => Promise<void>;
} {
  const [active, setActive] = useState<HiveRunStatusEvent | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  useEffect(() => {
    const offStatus = window.hive.run.onStatus((e) => {
      setActive(e.status === 'exited' ? null : e);
    });
    const offLog = window.hive.run.onLog((e) => {
      setLogLines((prev) => [...prev.slice(-499), e.line]);
    });
    return () => {
      offStatus();
      offLog();
    };
  }, []);

  return {
    active,
    logLines,
    start: async (storyId) => {
      setLogLines([]);
      await window.hive.run.start(storyId);
    },
    stop: async () => {
      if (active) await window.hive.run.stop(active.runId);
    },
  };
}
```

- [ ] **Step 2: Wire Run/Stop into the Stories board rows**

In `AgentDock.tsx`, call `useHiveRun()` near the top of the Dock component. For
each story row in the Stories board, render a Run button when no run is active,
and a Stop button on the row whose `storyId === active?.storyId`; disable Run on
all rows while `active !== null`. Use the existing button primitive (`Btn`) and
`Icon`. Minimal example for a row with `storyId`:

```tsx
const run = useHiveRun();
// …per row:
{run.active && run.active.storyId === storyId ? (
  <Btn kind="ghost" sm icon="square" onClick={() => void run.stop()}>Stop</Btn>
) : (
  <Btn kind="ghost" sm icon="play" disabled={run.active !== null} onClick={() => void run.start(storyId)}>
    Run
  </Btn>
)}
```

Only show the control when a hive workspace is connected (reuse the slice-1
connection state already available in the Dock). Stream `run.logLines` into the
existing manager-log surface if the Dock owns it; otherwise it's enough for 2a
that the board reflects status (the watcher moves the row) — wiring the live log
into the manager-log tab is a nice-to-have, do it if the log surface is readily
threadable, else leave a `// TODO(slice-2b): stream run.logLines into manager log`
ONLY if you cannot reach it (prefer wiring it).

- [ ] **Step 3: Typecheck + full suite**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck && fnm exec --using=22 npx vitest run`
Expected: typecheck clean; full suite passes (no renderer test added; this
confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/useHiveRun.ts src/renderer/src/components/AgentDock.tsx
git commit -m "feat(hive): Run/Stop control + live run subscription (slice 2a)"
```

---

## Task 12: Full verification + manual end-to-end

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
Expected: all exit 0; tests all pass.

- [ ] **Step 2: Confirm the `claude` flags against the installed CLI**

Run: `claude --help | grep -E "append-system-prompt|dangerously-skip|output-format|--print"`
Expected: all four present. If the flag names differ on this machine's `claude`,
update `buildClaudeArgs` in `runner.ts` accordingly and re-run Task 6's test.

- [ ] **Step 3: Manual end-to-end (documented; run by the executor)**

1. Create a throwaway workspace: `mkdir -p /tmp/hivews/.hive/state/stories` and a
   repo `repos/demo` (git-init, one commit), then a story file
   `/tmp/hivews/.hive/state/stories/DEMO-1.md` with frontmatter
   (`status: pending`, `role: senior`, `team: demo`, an `acceptance_criteria`
   list) and a body asking for a tiny change (e.g. "add a HELLO.md file").
2. `npm run dev`, open the project whose first repo is `repos/demo`, connect the
   hive workspace (`/tmp/hivews`).
3. The Stories board shows DEMO-1 as pending with a **Run** button. Click Run.
4. Observe: a worktree appears under `/tmp/hivews/.hive/worktrees/DEMO-1`, the
   board row moves to **in-progress**, live log lines stream, and on completion
   the row moves to **review** with a commit on `feat/DEMO-1`.
5. Run a story the agent can't satisfy (impossible criteria) → confirm **blocked**.
6. Start a long run and press **Stop** → confirm the `claude` process dies
   (`pgrep -f 'claude -p'` empty) and the story returns to **pending**.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore(hive): slice-2a verification fixups"
```
(Skip if nothing changed.)

---

## Notes for the executor

- **Isolation is the safety boundary.** The worker only ever runs in
  `<workspace>/.hive/worktrees/<storyId>` with `--dangerously-skip-permissions`.
  Never spawn it in the user's working tree. If `createWorktree` can't isolate,
  abort the run.
- **The slice-1 watcher does the board.** You are NOT adding a new board render
  path — writing `stories/<id>.md` is what moves the row. Keep `serialize.ts`
  round-trip-clean against `parse.ts` or the watcher will mis-render.
- **One run at a time.** The runner's `isBusy` guard + the renderer disabling Run
  are both required; don't rely on only one.
- **Don't invent the workspace/repo accessors** in Task 9 — wire to whatever
  slice 1 already tracks for the connected workspace and active project repo.
