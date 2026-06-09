# Hive Manager LLM — Slice 2b-2a (Repo Indexing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a repo is added / a project connects / the app starts, hive runs a read-only `claude` indexer whose final text becomes a compact `.hive/index/<repo>.md` profile, surfaced per-repo in the Dock with a manual Re-index action.

**Architecture:** A second `createRunner()` instance ("manager lane") plus a FIFO job queue runs index jobs one at a time, independent of the worker lane. The runner gains an optional `onResult(text)` hook that captures the agent's final stream-json `result`; the lane hands that text to the job, which writes the profile. Both the `onResult` runner extension and the generic lane/queue are shared infrastructure that slice 2b-2b (decomposition) will reuse for a `decompose` job kind.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React, Zustand, Vitest (node env for main, happy-dom for renderer), yaml.

---

## File Structure

- `src/types/hive.ts` — **modify** — add a "Slice 2b-2" section with `RepoProfile`, `IndexStatus`, `HiveManagerStatusEvent` (no status-enum changes).
- `src/main/hive/run/stream.ts` — **modify** — add pure `parseClaudeResult(line): string | null`.
- `src/main/hive/run/stream.test.ts` — **modify** — tests for `parseClaudeResult`.
- `src/main/hive/run/runner.ts` — **modify** — add optional `onResult?` to `RunnerEvents`; capture latest result, call it in `finish()` before `onExit`.
- `src/main/hive/run/runner.test.ts` — **modify** — tests for `onResult` (called with result text; absent → unaffected).
- `src/main/hive/manager/profile.ts` — **create** — `serializeProfile`, `parseProfile`, `readProfiles`.
- `src/main/hive/manager/profile.test.ts` — **create** — round-trip + defensive parse tests.
- `src/main/hive/manager/indexer.ts` — **create** — pure `buildIndexSystemPrompt()`, `buildIndexPrompt(repoName)`.
- `src/main/hive/manager/indexer.test.ts` — **create** — prompt-builder tests.
- `src/main/hive/manager/lane.ts` — **create** — `createManagerLane(deps)`: second runner + FIFO queue; generic `enqueue(job)`.
- `src/main/hive/manager/lane.test.ts` — **create** — FIFO/serial/failure tests with injected spawn + schedule.
- `src/main/hive/manager/handlers.ts` — **create** — channel/event constants + `registerHiveManagerHandlers(deps)` teardown.
- `src/main/hive/manager/handlers.test.ts` — **create** — registration/teardown tests.
- `src/main/index.ts` — **modify** — build the manager lane, wire `reindex`/`indexStatus`, auto-enqueue on connect + app start, push manager status, reap on before-quit.
- `src/preload/api.ts` — **modify** — add `repo`/`index`/`manager` bridge types; re-export `IndexStatus`, `HiveManagerStatusEvent`.
- `src/preload/index.ts` — **modify** — add channel constants + bridge implementations.
- `src/renderer/src/lib/useManagerStatus.ts` — **create** — hook: subscribe to status, fetch + refresh `index.status()`, expose `{ status, reindex }`.
- `src/renderer/src/components/AgentDock.tsx` — **modify** — render per-repo index status + Re-index button in `RunPanel`.
- `src/renderer/src/styles/ide.css` — **modify** — add `idx-*` classes alongside the hive Dock styles.

---

## Notes for every task

- CI uses **node 22**. `typecheck` is `tsc -b` (incremental); a stale `.tsbuildinfo` can mask or invent errors, so always run `rm -f *.tsbuildinfo` before `npm run typecheck`.
- The full local check is: `rm -f *.tsbuildinfo && npm run typecheck && npx vitest run`.
- Each task is TDD: write the failing test, run it (expect FAIL), implement, run again (expect PASS), then commit.
- Commit convention: `feat(hive): …` / `test(hive): …`. End EVERY commit message body with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **This plan adds NO status-enum values** (`proposed` / `decomposing` belong to 2b-2b). The 2b-1 lesson — "when you add a value to a status union with a coercion array, update both the union AND the array" — does not apply here; we only add new standalone interfaces/types. Do not touch `STORY_STATUSES`, `REQ_STATUSES`, or any status union.
- Agents in this slice are **READ-ONLY**: the indexer gets NO worktree, its cwd is the repo path, and it must not write — hive writes the profile from `onResult`. It still uses the existing `buildClaudeArgs` (which includes `--dangerously-skip-permissions`) for frictionless reads.
- The manager lane is a SEPARATE runner instance from the worker runner; the two lanes may overlap.

---

## Task 1: Add Slice 2b-2 types

**Files:**
- Modify: `src/types/hive.ts`

There is nothing to unit-test in a pure interface addition; this task just lands the types the rest of the slice imports. The "test" is that typecheck stays green. Append a new section at the END of the file (after the slice 2b-1 block that ends with the `HiveQuestion` interface).

- [ ] **Step 1: Add the Slice 2b-2 types.** Append this block to the end of `src/types/hive.ts` (the anchor is the final closing of the `HiveQuestion` interface; add a new `// ---` section after it):

```ts
// ---------------------------------------------------------------------------
// Slice 2b-2 — manager LLM (repo indexing)
// ---------------------------------------------------------------------------

/** A repo's indexed profile — `.hive/index/<repo>.md`. */
export interface RepoProfile {
  /** = filename stem = repo (team) name. */
  repo: string;
  indexedAt: string;
  /** Sha the profile was built from, when a git HEAD was reachable. */
  commit?: string;
  /** NL profile: purpose, stack, key dirs, public surface, test cmd. */
  body: string;
}

/** Per-repo indexing lifecycle surfaced in the UI. */
export type IndexStatus = 'unindexed' | 'indexing' | 'indexed' | 'failed';

/** Manager-lane run status pushed to the renderer. */
export interface HiveManagerStatusEvent {
  activity: 'indexing' | 'decomposing';
  /** repo name | requirement id. */
  target: string;
  status: 'starting' | 'running' | 'exited';
  outcome?: 'success' | 'failure';
  detail?: string;
}
```

- [ ] **Step 2: Typecheck.** Run `rm -f *.tsbuildinfo && npm run typecheck` — expect PASS (no other file imports these yet).
- [ ] **Step 3: Commit.**

```bash
git add src/types/hive.ts
git commit -m "$(cat <<'EOF'
feat(hive): add slice 2b-2 indexing types (RepoProfile, IndexStatus, HiveManagerStatusEvent)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `parseClaudeResult` in stream.ts

**Files:**
- Modify: `src/main/hive/run/stream.ts`
- Test: `src/main/hive/run/stream.test.ts`

`parseClaudeResult` returns the RAW `result` string from a `type:"result"` line (not the `✓ …` rendering `parseClaudeStreamLine` produces) — null for non-result lines, malformed JSON, missing/non-string `result`, or an empty result string. It mirrors the defensive style of `parseClaudeStreamLine`.

- [ ] **Step 1: Write the failing tests.** Append to `src/main/hive/run/stream.test.ts`. First update the import line at the top:

```ts
import { parseClaudeStreamLine, parseClaudeResult } from './stream';
```

Then add a new describe block at the end of the file:

```ts
describe('parseClaudeResult', () => {
  it('returns the raw result string from a result line', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'the profile body' });
    expect(parseClaudeResult(line)).toBe('the profile body');
  });

  it('returns the result text even on an error result (caller decides)', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: 'boom' });
    expect(parseClaudeResult(line)).toBe('boom');
  });

  it('returns null for a non-result line', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    expect(parseClaudeResult(line)).toBeNull();
  });

  it('returns null for a blank line', () => {
    expect(parseClaudeResult('')).toBeNull();
    expect(parseClaudeResult('   ')).toBeNull();
  });

  it('returns null for non-JSON (tolerated)', () => {
    expect(parseClaudeResult('not json')).toBeNull();
  });

  it('returns null when result is missing or not a string', () => {
    expect(parseClaudeResult(JSON.stringify({ type: 'result' }))).toBeNull();
    expect(parseClaudeResult(JSON.stringify({ type: 'result', result: 42 }))).toBeNull();
  });

  it('returns null for an empty result string', () => {
    expect(parseClaudeResult(JSON.stringify({ type: 'result', result: '' }))).toBeNull();
    expect(parseClaudeResult(JSON.stringify({ type: 'result', result: '   ' }))).toBeNull();
  });

  it('does not throw on a top-level JSON null line', () => {
    expect(parseClaudeResult('null')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL).** `npx vitest run src/main/hive/run/stream.test.ts` — fails to import `parseClaudeResult`.
- [ ] **Step 3: Implement.** Append to `src/main/hive/run/stream.ts` (after the `parseClaudeStreamLine` function):

```ts
/**
 * Extract the RAW `result` string from a `type:"result"` stream-json line.
 * Null for any other type, malformed JSON, a missing/non-string result, or an
 * empty result. This is the agent's FINAL text — the manager lane writes it.
 */
export function parseClaudeResult(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let ev: unknown;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (ev === null || typeof ev !== 'object') return null;
  const obj = ev as Record<string, unknown>;

  if (obj.type !== 'result') return null;
  const result = typeof obj.result === 'string' ? obj.result : '';
  return result.trim() !== '' ? result : null;
}
```

- [ ] **Step 4: Run the test (expect PASS).** `npx vitest run src/main/hive/run/stream.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/run/stream.ts src/main/hive/run/stream.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): add parseClaudeResult for the manager lane's final-text capture

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `onResult` runner extension

**Files:**
- Modify: `src/main/hive/run/runner.ts`
- Test: `src/main/hive/run/runner.test.ts`

Add optional `onResult?: (text: string) => void` to `RunnerEvents`. In the line loop, capture the LATEST `parseClaudeResult` value (the last non-null result string seen). Inside `finish()`, after flushing the residual partial line and before `onExit`, call `onResult(lastResult)` if both the callback is provided and a result was captured. Worker runs pass no `onResult` and must be byte-for-byte unaffected.

- [ ] **Step 1: Write the failing tests.** Update the import at the top of `src/main/hive/run/runner.test.ts` if needed (it already imports `createRunner, RunSpec, SpawnFn`). Add these tests inside the `describe('createRunner', …)` block:

```ts
  it('calls onResult with the raw result text before onExit', () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child as never);
    const runner = createRunner(spawnFn);
    const order: string[] = [];
    let resultText: string | null = null;
    runner.start(spec, {
      onLog: () => {},
      onStatus: () => {},
      onResult: (t) => { resultText = t; order.push('result'); },
      onExit: () => { order.push('exit'); },
    });
    child.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'result', is_error: false, result: 'PROFILE BODY' }) + '\n',
    ));
    child.emit('exit', 0, null);
    expect(resultText).toBe('PROFILE BODY');
    expect(order).toEqual(['result', 'exit']);
  });

  it('does not call onResult when no result line arrives', () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child as never);
    const runner = createRunner(spawnFn);
    const onResult = vi.fn();
    runner.start(spec, { onLog: () => {}, onStatus: () => {}, onResult, onExit: () => {} });
    child.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n',
    ));
    child.emit('exit', 0, null);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('keeps the latest result when multiple result lines arrive', () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child as never);
    const runner = createRunner(spawnFn);
    let resultText: string | null = null;
    runner.start(spec, { onLog: () => {}, onStatus: () => {}, onResult: (t) => { resultText = t; }, onExit: () => {} });
    child.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'result', result: 'first' }) + '\n' +
      JSON.stringify({ type: 'result', result: 'second' }) + '\n',
    ));
    child.emit('exit', 0, null);
    expect(resultText).toBe('second');
  });

  it('a run without onResult is unaffected (no throw)', () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child as never);
    const runner = createRunner(spawnFn);
    const exits: unknown[] = [];
    runner.start(spec, { onLog: () => {}, onStatus: () => {}, onExit: (r) => { exits.push(r); } });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: 'x' }) + '\n'));
    child.emit('exit', 0, null);
    expect(exits).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the test (expect FAIL).** `npx vitest run src/main/hive/run/runner.test.ts` — `onResult` is not a known property of `RunnerEvents` (typecheck) / not called.
- [ ] **Step 3: Implement.** In `src/main/hive/run/runner.ts`:

3a. Add `parseClaudeResult` to the existing stream import:

```ts
import { parseClaudeStreamLine, parseClaudeResult } from './stream';
```

3b. Add the optional callback to `RunnerEvents`:

```ts
export interface RunnerEvents {
  onLog: (line: string) => void;
  onStatus: (s: HiveRunStatus) => void;
  /** Latest stream-json `result` text, fired once before onExit when present. */
  onResult?: (text: string) => void;
  onExit: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
}
```

3c. In `start()`, declare a capture variable alongside `let buf = ''`:

```ts
      let buf = '';
      let lastResult: string | null = null;
      let settled = false;
```

3d. In `finish()`, after the residual-line flush block and `active = null`, but BEFORE `events.onStatus('exited')`, fire the result:

```ts
        active = null;
        if (lastResult !== null && events.onResult) events.onResult(lastResult);
        events.onStatus('exited');
        events.onExit(result);
```

3e. In `onChunk`, capture the result while iterating lines. Replace the loop body so each line is checked for a result in addition to being rendered:

```ts
      const onChunk = (chunk: Buffer | string): void => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const result = parseClaudeResult(line);
          if (result !== null) lastResult = result;
          const rendered = parseClaudeStreamLine(line);
          if (rendered !== null) events.onLog(rendered);
        }
      };
```

3f. Also capture from the residual partial line in `finish()` (defensive — claude flushes the result line with a trailing newline in practice, but a truncated stream must still surface what we saw). In `finish()`, where the residual buffer is flushed, add a result check before the render:

```ts
        // flush a residual partial line
        if (buf.trim() !== '') {
          const result = parseClaudeResult(buf);
          if (result !== null) lastResult = result;
          const rendered = parseClaudeStreamLine(buf);
          if (rendered !== null) events.onLog(rendered);
          buf = '';
        }
```

- [ ] **Step 4: Run the test (expect PASS).** `npx vitest run src/main/hive/run/runner.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/run/runner.ts src/main/hive/run/runner.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): add optional onResult to the runner so the manager lane captures final text

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Profile serialize / parse / read

**Files:**
- Create: `src/main/hive/manager/profile.ts`
- Test: `src/main/hive/manager/profile.test.ts`

`serializeProfile(p)` writes frontmatter (`repo`, `indexed_at`, optional `commit`) + body, mirroring `serialize.ts`'s `frontmatter` helper (snake_case keys, omit-undefined, trimmed body). `parseProfile(raw, repo)` mirrors `parse.ts`'s `splitFrontmatter` + defensive readers and always sets `repo` from the passed-in stem (filename is the source of truth, not the frontmatter). `readProfiles(indexDir)` mirrors `readKind`: read every `*.md`, parse, skip unreadable, return `[]` on missing dir. Round-trip: `parseProfile(serializeProfile(x), x.repo)` deep-equals `x`.

- [ ] **Step 1: Write the failing tests.** Create `src/main/hive/manager/profile.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serializeProfile, parseProfile, readProfiles } from './profile';
import type { RepoProfile } from '../../../types/hive';

const sample: RepoProfile = {
  repo: 'bff-web',
  indexedAt: '2026-06-09T16:40:00Z',
  commit: 'abc1234',
  body: 'Purpose: customer-facing web BFF.\nStack: TypeScript.\nTest: `npm test`.',
};

describe('serializeProfile / parseProfile', () => {
  it('round-trips a full profile', () => {
    expect(parseProfile(serializeProfile(sample), 'bff-web')).toEqual(sample);
  });

  it('round-trips a profile with no commit (omits the key)', () => {
    const p: RepoProfile = { repo: 'policy', indexedAt: '2026-06-09T10:00:00Z', body: 'Purpose: policy svc.' };
    const raw = serializeProfile(p);
    expect(raw).not.toContain('commit:');
    expect(parseProfile(raw, 'policy')).toEqual(p);
  });

  it('always takes repo from the passed-in stem, not the frontmatter', () => {
    const raw = serializeProfile(sample);
    expect(parseProfile(raw, 'renamed').repo).toBe('renamed');
  });

  it('tolerates a file with no frontmatter', () => {
    const p = parseProfile('just a body, no fences', 'x');
    expect(p.repo).toBe('x');
    expect(p.indexedAt).toBe('');
    expect(p.commit).toBeUndefined();
    expect(p.body).toBe('just a body, no fences');
  });
});

describe('readProfiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'hive-profiles-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing dir', async () => {
    expect(await readProfiles(join(dir, 'nope'))).toEqual([]);
  });

  it('reads and parses every .md, ignoring non-md', async () => {
    await fs.writeFile(join(dir, 'bff-web.md'), serializeProfile(sample), 'utf8');
    await fs.writeFile(join(dir, 'README.txt'), 'ignore me', 'utf8');
    const out = await readProfiles(dir);
    expect(out).toEqual([sample]);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL).** `npx vitest run src/main/hive/manager/profile.test.ts` — module not found.
- [ ] **Step 3: Implement.** Create `src/main/hive/manager/profile.ts`:

```ts
/**
 * Repo-profile serialize/parse/read (pure + fs read) — slice 2b-2a.
 *
 * Mirrors `../run/serialize.ts` (the `frontmatter` helper: snake_case keys,
 * omit-undefined, trimmed body) and `../parse.ts` (`splitFrontmatter`,
 * defensive readers, skip-unreadable directory reads). The filename stem is the
 * source of truth for `repo`, never the frontmatter — so a renamed file wins.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

import type { RepoProfile } from '../../../types/hive';
import { splitFrontmatter } from '../parse';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function serializeProfile(p: RepoProfile): string {
  const data: Record<string, unknown> = {
    repo: p.repo,
    indexed_at: p.indexedAt,
    commit: p.commit,
  };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringify(clean).trimEnd();
  const body = p.body.trim();
  return `---\n${yaml}\n---\n${body ? body + '\n' : ''}`;
}

export function parseProfile(raw: string, repo: string): RepoProfile {
  const { data, body } = splitFrontmatter(raw);
  return {
    repo,
    indexedAt: str(data.indexed_at) ?? '',
    commit: str(data.commit),
    body,
  };
}

/** Read + parse every `<indexDir>/*.md`. Missing dir → []. */
export async function readProfiles(indexDir: string): Promise<RepoProfile[]> {
  let names: string[];
  try {
    names = await fs.readdir(indexDir);
  } catch {
    return [];
  }
  const out: RepoProfile[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const repo = name.slice(0, -3);
    try {
      const raw = await fs.readFile(join(indexDir, name), 'utf8');
      out.push(parseProfile(raw, repo));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`hive profile: failed to read ${join(indexDir, name)}`, e);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test (expect PASS).** `npx vitest run src/main/hive/manager/profile.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/manager/profile.ts src/main/hive/manager/profile.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): add repo-profile serialize/parse/read for the index store

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Indexer prompt builders

**Files:**
- Create: `src/main/hive/manager/indexer.ts`
- Test: `src/main/hive/manager/indexer.test.ts`

Two pure builders. `buildIndexSystemPrompt()` instructs a READ-ONLY analyst: do NOT edit/commit/write any files; read the README, manifests (package.json / go.mod / etc), directory structure, key entry points, and the test command; OUTPUT the profile as your FINAL message only. `buildIndexPrompt(repoName)` names the repo and asks for: Purpose, Stack, Key areas/directories, Public surface/entry points, Test command — concise.

- [ ] **Step 1: Write the failing tests.** Create `src/main/hive/manager/indexer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { buildIndexSystemPrompt, buildIndexPrompt } from './indexer';

describe('buildIndexSystemPrompt', () => {
  const sys = buildIndexSystemPrompt();

  it('forbids writing / editing / committing', () => {
    expect(sys).toMatch(/do not (edit|write|commit|modify)/i);
    expect(sys.toLowerCase()).toContain('read-only');
  });

  it('tells the agent its output is its final message', () => {
    expect(sys.toLowerCase()).toContain('final message');
  });

  it('mentions the things to read (readme, manifests, structure, test command)', () => {
    const lower = sys.toLowerCase();
    expect(lower).toContain('readme');
    expect(lower).toContain('package.json');
    expect(lower).toContain('test');
  });
});

describe('buildIndexPrompt', () => {
  it('names the repo', () => {
    expect(buildIndexPrompt('bff-web')).toContain('bff-web');
  });

  it('asks for the required profile sections', () => {
    const p = buildIndexPrompt('bff-web').toLowerCase();
    expect(p).toContain('purpose');
    expect(p).toContain('stack');
    expect(p).toContain('key areas');
    expect(p).toContain('entry point');
    expect(p).toContain('test command');
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL).** `npx vitest run src/main/hive/manager/indexer.test.ts` — module not found.
- [ ] **Step 3: Implement.** Create `src/main/hive/manager/indexer.ts`:

```ts
/**
 * Indexer prompts (pure) — slice 2b-2a.
 *
 * The indexer is a READ-ONLY analyst run in the repo's cwd (NO worktree). Its
 * FINAL message text IS the profile body — hive captures it via the runner's
 * onResult and writes `.hive/index/<repo>.md`. The agent never writes files.
 */

/** System prompt: a read-only repo analyst that emits its profile as final text. */
export function buildIndexSystemPrompt(): string {
  return [
    'You are a READ-ONLY repository analyst. Your sole job is to read a code',
    'repository and produce a compact profile of it.',
    '',
    'Hard rules:',
    '- Do NOT edit, write, create, delete, or modify any file.',
    '- Do NOT commit, stage, push, or run git write commands.',
    '- Do NOT run build/test/install commands — only READ.',
    '- Read the README, the manifests (package.json, go.mod, pom.xml,',
    '  Cargo.toml, pyproject.toml, etc.), the top-level directory structure,',
    '  the key entry points, and how tests are run.',
    '',
    'Output the profile as your FINAL message only — no preamble, no trailing',
    'commentary. Keep it concise (a dozen lines is plenty).',
  ].join('\n');
}

/** Task prompt: profile this one repo into the required sections. */
export function buildIndexPrompt(repoName: string): string {
  return [
    `Profile the repository "${repoName}" that you are currently inside.`,
    '',
    'Produce a concise profile with these sections (one short paragraph or a',
    'few bullet points each):',
    '- Purpose: what this repo is and does.',
    '- Stack: languages, frameworks, notable tooling.',
    '- Key areas / directories: where the important code lives.',
    '- Public surface / entry points: the main modules, commands, or endpoints.',
    '- Test command: the exact command to run its tests.',
    '',
    'Be concise. Your final message is the profile and nothing else.',
  ].join('\n');
}
```

- [ ] **Step 4: Run the test (expect PASS).** `npx vitest run src/main/hive/manager/indexer.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/manager/indexer.ts src/main/hive/manager/indexer.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): add read-only indexer prompt builders

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The manager lane (second runner + FIFO queue)

**Files:**
- Create: `src/main/hive/manager/lane.ts`
- Test: `src/main/hive/manager/lane.test.ts`

`createManagerLane(deps)` holds a SECOND runner (built from an injected `createRunner` so tests inject a fake spawn) plus a FIFO job queue. A job is GENERIC so 2b-2b can add a `decompose` kind later: a job knows how to build its `RunSpec` (`buildSpec()`), how to handle its captured result (`onResult(text)`), and how to handle failure (`onFailure(detail)`). The lane runs ONE job at a time; `enqueue` while busy → queued; on completion the next dequeues. `schedule`/`now`/`newRunId` are injected (mirroring supervisor + runner tests). The lane fires `onStatus(HiveManagerStatusEvent)` for each job (`starting` → `running` → `exited`). Failure = non-zero exit OR spawn error (`code === null && signal === null`) OR an empty/absent result → the job's `onFailure` runs and the lane continues to the next job.

The job carries the metadata for the status event (`activity` + `target`). For an index job, `activity: 'indexing'`, `target: <repo>`.

- [ ] **Step 1: Write the failing tests.** Create `src/main/hive/manager/lane.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { createManagerLane, type ManagerJob, type ManagerLaneDeps } from './lane';
import type { RunSpec, RunnerEvents, Runner, SpawnFn } from '../run/runner';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 7;
  return child;
}

/**
 * A controllable fake runner: records start() calls and lets the test drive a
 * run to completion (with an optional result + exit code).
 */
function fakeRunner() {
  let busy = false;
  let pending: { spec: RunSpec; events: RunnerEvents } | null = null;
  const runner: Runner = {
    isBusy: () => busy,
    start: (spec, events) => {
      if (busy) throw new Error('busy');
      busy = true;
      pending = { spec, events };
      events.onStatus('starting');
      events.onStatus('running');
    },
    stop: async () => { busy = false; },
  };
  const finish = (opts: { result?: string; code?: number | null; signal?: NodeJS.Signals | null }): void => {
    const p = pending!;
    pending = null;
    busy = false;
    if (opts.result !== undefined && p.events.onResult) p.events.onResult(opts.result);
    p.events.onStatus('exited');
    p.events.onExit({ code: opts.code ?? 0, signal: opts.signal ?? null });
  };
  return { runner, finish, started: () => pending, calls: () => pending };
}

function indexJob(repo: string, sink: (kind: string, repo: string, text?: string) => void): ManagerJob {
  return {
    activity: 'indexing',
    target: repo,
    buildSpec: (runId) => ({
      runId, storyId: repo, role: 'manager', cwd: `/repos/${repo}`,
      taskPrompt: `index ${repo}`, systemPrompt: 'read-only',
    }),
    onResult: (text) => sink('result', repo, text),
    onFailure: (detail) => sink('failure', repo, detail),
  };
}

function harness(over: Partial<ManagerLaneDeps> = {}) {
  const fr = fakeRunner();
  const events: Array<{ activity: string; target: string; status: string; outcome?: string }> = [];
  const deps: ManagerLaneDeps = {
    createRunner: () => fr.runner,
    onStatus: (e) => events.push({ activity: e.activity, target: e.target, status: e.status, outcome: e.outcome }),
    now: () => '2026-06-09T00:00:00Z',
    newRunId: () => 'run_x',
    ...over,
  };
  const lane = createManagerLane(deps);
  return { lane, fr, events };
}

describe('createManagerLane', () => {
  it('runs an enqueued index job and hands the result to onResult', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('bff-web', sink));
    expect(fr.started()).not.toBeNull();
    fr.finish({ result: 'PROFILE' });
    expect(sink).toHaveBeenCalledWith('result', 'bff-web', 'PROFILE');
  });

  it('runs jobs serially: a job enqueued while busy waits its turn', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('a', sink));
    lane.enqueue(indexJob('b', sink));            // queued behind a
    expect(fr.started()?.spec.cwd).toBe('/repos/a');
    fr.finish({ result: 'PA' });
    expect(fr.started()?.spec.cwd).toBe('/repos/b'); // b dequeued
    fr.finish({ result: 'PB' });
    expect(sink).toHaveBeenNthCalledWith(1, 'result', 'a', 'PA');
    expect(sink).toHaveBeenNthCalledWith(2, 'result', 'b', 'PB');
  });

  it('treats a non-zero exit as failure and continues to the next job', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('a', sink));
    lane.enqueue(indexJob('b', sink));
    fr.finish({ code: 1 });                       // a fails
    expect(sink).toHaveBeenCalledWith('failure', 'a', expect.any(String));
    expect(fr.started()?.spec.cwd).toBe('/repos/b'); // lane moved on
    fr.finish({ result: 'PB' });
    expect(sink).toHaveBeenCalledWith('result', 'b', 'PB');
  });

  it('treats a spawn error (code null, signal null) as failure', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('a', sink));
    fr.finish({ code: null, signal: null });
    expect(sink).toHaveBeenCalledWith('failure', 'a', expect.any(String));
  });

  it('treats an empty/absent result on a clean exit as failure', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    lane.enqueue(indexJob('a', sink));
    fr.finish({ code: 0 });                        // no result captured
    expect(sink).toHaveBeenCalledWith('failure', 'a', expect.any(String));
    expect(sink).not.toHaveBeenCalledWith('result', 'a', expect.anything());
  });

  it('emits starting/running/exited status with the job target', () => {
    const sink = vi.fn();
    const { lane, fr, events } = harness();
    lane.enqueue(indexJob('a', sink));
    fr.finish({ result: 'P' });
    expect(events.map((e) => e.status)).toEqual(['starting', 'running', 'exited']);
    expect(events.every((e) => e.activity === 'indexing' && e.target === 'a')).toBe(true);
    expect(events.at(-1)?.outcome).toBe('success');
  });

  it('reports a current/queued snapshot via isRunning + pending', () => {
    const sink = vi.fn();
    const { lane, fr } = harness();
    expect(lane.current()).toBeNull();
    lane.enqueue(indexJob('a', sink));
    lane.enqueue(indexJob('b', sink));
    expect(lane.current()).toEqual({ activity: 'indexing', target: 'a' });
    expect(lane.queued()).toEqual([{ activity: 'indexing', target: 'b' }]);
    fr.finish({ result: 'P' });
    expect(lane.current()).toEqual({ activity: 'indexing', target: 'b' });
    fr.finish({ result: 'P2' });
    expect(lane.current()).toBeNull();
  });

  it('dispose() stops the active run and clears the queue', async () => {
    const sink = vi.fn();
    const stop = vi.fn(async () => {});
    const fr = fakeRunner();
    fr.runner.stop = stop;
    const { lane } = harness({ createRunner: () => fr.runner });
    lane.enqueue(indexJob('a', sink));
    lane.enqueue(indexJob('b', sink));
    await lane.dispose();
    expect(stop).toHaveBeenCalled();
    expect(lane.queued()).toEqual([]);
  });
});
```

> Note: the test imports `SpawnFn` type only to satisfy the `RunSpec`/`Runner` re-use; if your runner module does not re-export it where expected, drop the unused import — the lane test does not spawn anything real.

- [ ] **Step 2: Run the test (expect FAIL).** `npx vitest run src/main/hive/manager/lane.test.ts` — module not found.
- [ ] **Step 3: Implement.** Create `src/main/hive/manager/lane.ts`:

```ts
/**
 * Manager lane (slice 2b-2a) — a SECOND runner instance + a FIFO job queue.
 *
 * Jobs run ONE AT A TIME within the lane; the worker lane is independent and
 * may overlap. A job is generic (it builds its own RunSpec and handles its own
 * result/failure) so slice 2b-2b can add a `decompose` job kind without
 * touching the lane. `createRunner`/`now`/`newRunId` are injected so the lane
 * is testable without a real `claude` or real timers.
 */

import type { HiveManagerStatusEvent } from '../../../types/hive';
import { createRunner as defaultCreateRunner, type Runner, type RunSpec } from '../run/runner';

/** One unit of manager-lane work. Generic over kind via its callbacks. */
export interface ManagerJob {
  activity: HiveManagerStatusEvent['activity'];
  /** repo name | requirement id — also the status-event target. */
  target: string;
  /** Build the claude RunSpec for this job (cwd, prompts, etc). */
  buildSpec: (runId: string) => RunSpec;
  /** The run's captured final text (non-empty) on a clean, successful exit. */
  onResult: (text: string) => void | Promise<void>;
  /** Non-zero exit, spawn error, or empty result. */
  onFailure: (detail: string) => void | Promise<void>;
}

export interface ManagerLaneDeps {
  /** Factory for the lane's dedicated runner. Defaults to the real one. */
  createRunner?: () => Runner;
  onStatus: (e: HiveManagerStatusEvent) => void;
  now: () => string;
  newRunId: () => string;
}

/** A compact view of what the lane is doing (for index-status derivation). */
export interface ManagerJobRef {
  activity: HiveManagerStatusEvent['activity'];
  target: string;
}

export interface ManagerLane {
  enqueue(job: ManagerJob): void;
  /** The job currently running, or null. */
  current(): ManagerJobRef | null;
  /** Jobs waiting behind the current one, in FIFO order. */
  queued(): ManagerJobRef[];
  isBusy(): boolean;
  /** Stop the active run and clear the queue (before-quit). */
  dispose(): Promise<void>;
}

export function createManagerLane(deps: ManagerLaneDeps): ManagerLane {
  const runner = (deps.createRunner ?? defaultCreateRunner)();
  const queue: ManagerJob[] = [];
  let active: ManagerJob | null = null;

  const ref = (j: ManagerJob): ManagerJobRef => ({ activity: j.activity, target: j.target });
  const status = (j: ManagerJob, s: HiveManagerStatusEvent['status'], extra: Partial<HiveManagerStatusEvent> = {}): void =>
    deps.onStatus({ activity: j.activity, target: j.target, status: s, ...extra });

  const pump = (): void => {
    if (active !== null) return;
    const job = queue.shift();
    if (!job) return;
    active = job;

    const runId = deps.newRunId();
    let result: string | null = null;

    runner.start(job.buildSpec(runId), {
      onLog: () => {},
      onStatus: (s) => {
        // The runner emits starting/running/exited; forward only starting+running
        // here. We emit 'exited' ourselves once the outcome is known.
        if (s !== 'exited') status(job, s);
      },
      onResult: (text) => { result = text; },
      onExit: (r) => {
        void (async () => {
          const failed = r.code !== 0 || r.signal !== null || result === null || result.trim() === '';
          try {
            if (failed) {
              const detail =
                r.signal !== null ? `interrupted (${r.signal})`
                : r.code !== 0 && r.code !== null ? `exit ${r.code}`
                : r.code === null ? 'spawn error'
                : 'empty result';
              await job.onFailure(detail);
              status(job, 'exited', { outcome: 'failure', detail });
            } else {
              await job.onResult(result as string);
              status(job, 'exited', { outcome: 'success' });
            }
          } finally {
            active = null;
            pump();
          }
        })();
      },
    });
  };

  return {
    enqueue(job) {
      queue.push(job);
      pump();
    },
    current: () => (active ? ref(active) : null),
    queued: () => queue.map(ref),
    isBusy: () => active !== null,
    dispose: async () => {
      queue.length = 0;
      await runner.stop(deps.newRunId()).catch(() => undefined);
    },
  };
}
```

> The `dispose()` stop uses a fresh id only to satisfy `runner.stop(runId)`; the real runner ignores a non-matching id and the injected fake's `stop` ignores it too. (If a future change tracks the active runId for a precise stop, thread it through here.)

- [ ] **Step 4: Run the test (expect PASS).** `npx vitest run src/main/hive/manager/lane.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/manager/lane.ts src/main/hive/manager/lane.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): add the manager lane (second runner + FIFO job queue)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manager IPC handlers

**Files:**
- Create: `src/main/hive/manager/handlers.ts`
- Test: `src/main/hive/manager/handlers.test.ts`

`HIVE_MANAGER_CHANNELS = { reindex, indexStatus }`, `HIVE_MANAGER_EVENTS = { status }`, and `registerHiveManagerHandlers(deps)` returning a teardown that `removeHandler`s every channel — mirroring `registerHiveLoopHandlers` exactly (ipcMain.handle, the `for (const c of Object.values(...))` teardown loop). Deps: `reindex(repo): Promise<void>`, `indexStatus(): Promise<Record<string, IndexStatus>>`.

The test mocks `electron`'s `ipcMain` (mirror the pattern used in the other handlers tests in this repo — `vi.mock('electron', …)` exposing `handle` + `removeHandler` spies).

- [ ] **Step 1: Write the failing tests.** Create `src/main/hive/manager/handlers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handle = vi.fn();
const removeHandler = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle: (...a: unknown[]) => handle(...a), removeHandler: (...a: unknown[]) => removeHandler(...a) } }));

import {
  HIVE_MANAGER_CHANNELS,
  HIVE_MANAGER_EVENTS,
  registerHiveManagerHandlers,
} from './handlers';
import type { IndexStatus } from '../../../types/hive';

beforeEach(() => {
  handle.mockClear();
  removeHandler.mockClear();
});

describe('registerHiveManagerHandlers', () => {
  it('registers a handler for every manager channel', () => {
    registerHiveManagerHandlers({ reindex: vi.fn(async () => {}), indexStatus: vi.fn(async () => ({})) });
    const registered = handle.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(expect.arrayContaining(Object.values(HIVE_MANAGER_CHANNELS)));
  });

  it('reindex handler forwards the repo arg', async () => {
    const reindex = vi.fn(async () => {});
    registerHiveManagerHandlers({ reindex, indexStatus: vi.fn(async () => ({})) });
    const call = handle.mock.calls.find((c) => c[0] === HIVE_MANAGER_CHANNELS.reindex)!;
    await (call[1] as (e: unknown, a: { repo: string }) => Promise<void>)({}, { repo: 'bff-web' });
    expect(reindex).toHaveBeenCalledWith('bff-web');
  });

  it('indexStatus handler returns the status map', async () => {
    const map: Record<string, IndexStatus> = { 'bff-web': 'indexed' };
    registerHiveManagerHandlers({ reindex: vi.fn(async () => {}), indexStatus: vi.fn(async () => map) });
    const call = handle.mock.calls.find((c) => c[0] === HIVE_MANAGER_CHANNELS.indexStatus)!;
    expect(await (call[1] as () => Promise<unknown>)()).toEqual(map);
  });

  it('teardown removes every channel', () => {
    const teardown = registerHiveManagerHandlers({ reindex: vi.fn(async () => {}), indexStatus: vi.fn(async () => ({})) });
    teardown();
    const removed = removeHandler.mock.calls.map((c) => c[0]);
    expect(removed).toEqual(expect.arrayContaining(Object.values(HIVE_MANAGER_CHANNELS)));
  });

  it('exposes the status push-event channel name', () => {
    expect(HIVE_MANAGER_EVENTS.status).toBe('event:hive:manager:status');
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL).** `npx vitest run src/main/hive/manager/handlers.test.ts` — module not found.
- [ ] **Step 3: Implement.** Create `src/main/hive/manager/handlers.ts`:

```ts
/**
 * Manager-lane IPC (slice 2b-2a) — reindex + index-status request/response and
 * the manager-status push-event channel. Mirrors `registerHiveLoopHandlers`:
 * ipcMain.handle per channel; teardown removes them all.
 */

import { ipcMain } from 'electron';

import type { IndexStatus } from '../../../types/hive';

export const HIVE_MANAGER_CHANNELS = {
  reindex: 'ipc:hive:repo:reindex',
  indexStatus: 'ipc:hive:index:status',
} as const;

export const HIVE_MANAGER_EVENTS = {
  status: 'event:hive:manager:status',
} as const;

export interface ManagerDeps {
  /** Enqueue an index job for one repo. */
  reindex: (repo: string) => Promise<void>;
  /** Current per-repo index status for the active workspace. */
  indexStatus: () => Promise<Record<string, IndexStatus>>;
}

export function registerHiveManagerHandlers(deps: ManagerDeps): () => void {
  ipcMain.handle(HIVE_MANAGER_CHANNELS.reindex, (_e, args: { repo: string }) =>
    deps.reindex(args.repo),
  );
  ipcMain.handle(HIVE_MANAGER_CHANNELS.indexStatus, () => deps.indexStatus());
  return () => {
    for (const c of Object.values(HIVE_MANAGER_CHANNELS)) ipcMain.removeHandler(c);
  };
}
```

- [ ] **Step 4: Run the test (expect PASS).** `npx vitest run src/main/hive/manager/handlers.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/main/hive/manager/handlers.ts src/main/hive/manager/handlers.test.ts
git commit -m "$(cat <<'EOF'
feat(hive): add manager IPC handlers (reindex + index-status + status event)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Main wiring

**Files:**
- Modify: `src/main/index.ts`

This is integration glue (no new unit test — covered by typecheck + the unit-tested units it composes). Mirror the existing hive wiring exactly. The relevant anchors are: the top-of-file imports, the module-scoped teardown handles block, the `whenReady` body (where `hiveRunner`/`hiveSupervisor` are built), and the `before-quit` handler.

The lane's index job, on success, writes `.hive/index/<repo>.md` from the result text plus the captured HEAD sha; on failure it records the repo as failed. `indexStatus()` derives each repo's status: profile file present → `indexed`; the lane's `current()`/`queued()` targeting that repo → `indexing`; last job for that repo failed → `failed`; else `unindexed`. Auto-enqueue index jobs for repos with no profile on workspace connect AND on app start.

- [ ] **Step 1: Add imports.** In the import block near the other `./hive/*` imports, add:

```ts
import { createManagerLane, type ManagerJob } from './hive/manager/lane';
import { serializeProfile, readProfiles } from './hive/manager/profile';
import { buildIndexSystemPrompt, buildIndexPrompt } from './hive/manager/indexer';
import {
  registerHiveManagerHandlers,
  HIVE_MANAGER_EVENTS,
} from './hive/manager/handlers';
import type { IndexStatus, HiveManagerStatusEvent, RepoProfile } from '../types/hive';
import { writeFile } from 'node:fs/promises';
```

> `readFile`, `mkdir`, `readdir` are already imported from `node:fs/promises` at the top; only `writeFile` is new. If `writeFile` is already present, skip it.

- [ ] **Step 2: Add module-scoped handles.** Next to the other `let teardownHive*` / `let hiveSupervisor` declarations, add:

```ts
let teardownHiveManagerHandlers: (() => void) | undefined;
let hiveManagerLane: ReturnType<typeof createManagerLane> | null = null;
/** Last-known per-repo index outcome, for the `failed` status (cleared on re-enqueue). */
const hiveIndexFailed = new Set<string>();
```

- [ ] **Step 3: Build the lane + index-job factory inside `whenReady`.** Place this AFTER `hiveSupervisor`/`registerHiveLoopHandlers` are set up and BEFORE `registerHiveAuthoringHandlers` (so `activeWorkspacePath`, `activeRepos`, `hiveSend`, `hiveGit` are all in scope):

```ts
  // ----- Manager lane (slice 2b-2a): repo indexing ------------------------
  const indexDirFor = (ws: string): string => join(ws, '.hive', 'index');
  const profilePath = (ws: string, repo: string): string =>
    join(indexDirFor(ws), `${repo}.md`);

  /** Best-effort HEAD sha for a repo, or undefined when git is unreachable. */
  const headSha = async (repoPath: string): Promise<string | undefined> => {
    try {
      const { stdout, code } = await hiveGit.run(repoPath, ['rev-parse', '--short', 'HEAD']);
      const sha = stdout.trim();
      return code === 0 && sha ? sha : undefined;
    } catch {
      return undefined;
    }
  };

  const makeIndexJob = (repo: string, repoPath: string): ManagerJob => ({
    activity: 'indexing',
    target: repo,
    buildSpec: (runId) => ({
      runId,
      storyId: repo,            // reused as a label; no story involved
      role: 'manager',
      cwd: repoPath,            // READ-ONLY run in the repo itself; NO worktree
      taskPrompt: buildIndexPrompt(repo),
      systemPrompt: buildIndexSystemPrompt(),
    }),
    onResult: async (text) => {
      const ws = activeWorkspacePath();
      if (!ws) return;
      const profile: RepoProfile = {
        repo,
        indexedAt: new Date().toISOString(),
        commit: await headSha(repoPath),
        body: text,
      };
      const dir = indexDirFor(ws);
      await mkdir(dir, { recursive: true });
      await writeFile(profilePath(ws, repo), serializeProfile(profile), 'utf8');
      hiveIndexFailed.delete(repo);
    },
    onFailure: () => {
      hiveIndexFailed.add(repo);
    },
  });

  hiveManagerLane = createManagerLane({
    onStatus: (e: HiveManagerStatusEvent) => hiveSend(HIVE_MANAGER_EVENTS.status, e),
    now: () => new Date().toISOString(),
    newRunId: () => `idx_${randomUUID().slice(0, 8)}`,
  });

  /** Enqueue an index job for one repo by name (no-op if unknown / no ws). */
  const reindexRepo = async (repo: string): Promise<void> => {
    if (!activeWorkspacePath()) return;
    const r = activeRepos().find((x) => x.name === repo);
    if (!r) return;
    hiveIndexFailed.delete(repo);
    hiveManagerLane?.enqueue(makeIndexJob(repo, r.path));
  };

  /** Enqueue index jobs for every repo that has no profile yet. */
  const autoIndexUnindexed = async (): Promise<void> => {
    const ws = activeWorkspacePath();
    if (!ws) return;
    const profiles = await readProfiles(indexDirFor(ws));
    const have = new Set(profiles.map((p) => p.repo));
    for (const r of activeRepos()) {
      if (!have.has(r.name)) {
        hiveManagerLane?.enqueue(makeIndexJob(r.name, r.path));
      }
    }
  };

  const computeIndexStatus = async (): Promise<Record<string, IndexStatus>> => {
    const ws = activeWorkspacePath();
    const out: Record<string, IndexStatus> = {};
    if (!ws) return out;
    const profiles = await readProfiles(indexDirFor(ws));
    const have = new Set(profiles.map((p) => p.repo));
    const running = hiveManagerLane?.current();
    const queuedTargets = new Set((hiveManagerLane?.queued() ?? []).map((q) => q.target));
    for (const r of activeRepos()) {
      const name = r.name;
      const isRunning = running?.activity === 'indexing' && running.target === name;
      if (isRunning || queuedTargets.has(name)) out[name] = 'indexing';
      else if (have.has(name)) out[name] = 'indexed';
      else if (hiveIndexFailed.has(name)) out[name] = 'failed';
      else out[name] = 'unindexed';
    }
    return out;
  };

  teardownHiveManagerHandlers = registerHiveManagerHandlers({
    reindex: reindexRepo,
    indexStatus: computeIndexStatus,
  });

  // Index any repos that have no profile yet, on app start.
  void autoIndexUnindexed();
```

> `current()` ranks above `queued()` here only for readability — both map to `'indexing'`. A re-index of an already-`indexed` repo shows `indexing` while in-flight (matching the spec's "in-flight job → indexing"), because `current()`/`queued()` is checked before the `have` set.

- [ ] **Step 4: Re-index on workspace connect.** The authoring `setReaderWorkspace` is where a workspace first goes live. Extend it so connecting also kicks off auto-indexing:

```ts
    setReaderWorkspace: async (workspacePath) => {
      await hiveReader.setWorkspace(workspacePath);
      void autoIndexUnindexed();
    },
```

> This replaces the existing `setReaderWorkspace` body in the `registerHiveAuthoringHandlers({ … })` call. `autoIndexUnindexed` reads `activeRepos()` + the index dir, so it must be defined before this object literal — Step 3 places it earlier in `whenReady`, so the closure is in scope.

- [ ] **Step 5: before-quit teardown.** In the `before-quit` handler, alongside the other hive teardowns (right after the `teardownHiveLoopHandlers?.()` block and before the worker `hiveRunner` reap), add:

```ts
  teardownHiveManagerHandlers?.();
  teardownHiveManagerHandlers = undefined;
  if (hiveManagerLane) void hiveManagerLane.dispose();
  hiveManagerLane = null;
```

- [ ] **Step 6: Typecheck + full test run.** `rm -f *.tsbuildinfo && npm run typecheck && npx vitest run` — expect PASS.
- [ ] **Step 7: Commit.**

```bash
git add src/main/index.ts
git commit -m "$(cat <<'EOF'
feat(hive): wire the manager lane, auto-indexing, reindex + index-status into main

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Preload bridge

**Files:**
- Modify: `src/preload/api.ts`
- Modify: `src/preload/index.ts`

Add `repo: { reindex(repo) }`, `index: { status() }`, and `manager: { onStatus(handler) }` to `HiveBridge`, mirroring the existing `loop`/`questions` bridges. Re-export `IndexStatus` + `HiveManagerStatusEvent` from `api.ts`. The channel strings in `index.ts` MUST match `handlers.ts` char-for-char: `ipc:hive:repo:reindex`, `ipc:hive:index:status`, `event:hive:manager:status`.

- [ ] **Step 1 (api.ts): re-export the new types.** Add to the hive type re-export block (near `export type { HiveRunLogEvent, … }`):

```ts
export type { IndexStatus, HiveManagerStatusEvent } from '../types/hive';
```

- [ ] **Step 2 (api.ts): add the bridge interfaces.** After the `HiveQuestionsBridge` interface, add:

```ts
export type HiveManagerStatusHandler = (e: import('../types/hive').HiveManagerStatusEvent) => void;

/**
 * Hive repo-index bridge (slice 2b-2a) — trigger a manual re-index for one
 * repo, read the per-repo index-status map, and subscribe to manager-lane
 * status pushes. Subscription mirrors the loop bridge (on + removeListener).
 */
export interface HiveRepoBridge {
  reindex(repo: string): Promise<void>;
}

export interface HiveIndexBridge {
  status(): Promise<Record<string, import('../types/hive').IndexStatus>>;
}

export interface HiveManagerBridge {
  onStatus(handler: HiveManagerStatusHandler): Unsubscribe;
}
```

- [ ] **Step 3 (api.ts): add them to `HiveBridge`.** In the `HiveBridge` interface, after `questions: HiveQuestionsBridge;`, add:

```ts
  repo: HiveRepoBridge;
  index: HiveIndexBridge;
  manager: HiveManagerBridge;
```

- [ ] **Step 4 (index.ts): import the handler type + status-event type.** Extend the existing `./api` type import to include `HiveManagerStatusHandler`, and the `../types/hive` import to include `HiveManagerStatusEvent` + `IndexStatus`:

```ts
import type {
  FsChangeEvent,
  FsChangeHandler,
  HiveBridge,
  HiveConnectionHandler,
  HiveEventsHandler,
  HiveLoopStatusHandler,
  HiveManagerStatusHandler,
  HiveQuestionHandler,
  HiveRunLogHandler,
  HiveRunStatusHandler,
  HiveSnapshotHandler,
  Unsubscribe,
} from './api';
import type {
  HiveConnection,
  HiveEvent,
  HiveLoopStatus,
  HiveManagerStatusEvent,
  HiveQuestion,
  HiveRunLogEvent,
  HiveRunStatusEvent,
  HiveSnapshot,
  IndexStatus,
  NewStoryFields,
} from '../types/hive';
```

- [ ] **Step 5 (index.ts): add the channel constant block.** After the `HIVE_LOOP = { … }` block, add:

```ts
const HIVE_MANAGER = {
  reindex: 'ipc:hive:repo:reindex',
  indexStatus: 'ipc:hive:index:status',
  evtStatus: 'event:hive:manager:status',
} as const;
```

> VERIFY these three strings are char-for-char identical to `HIVE_MANAGER_CHANNELS` / `HIVE_MANAGER_EVENTS` in `src/main/hive/manager/handlers.ts`.

- [ ] **Step 6 (index.ts): add the bridge implementations.** In the `api` object, after the `questions: { … }` block, add:

```ts
  // Hive repo-index bridge (slice 2b-2a) — reindex + status request/response.
  repo: {
    reindex: (repo: string) => ipcRenderer.invoke(HIVE_MANAGER.reindex, { repo }),
  },

  index: {
    status: (): Promise<Record<string, IndexStatus>> =>
      ipcRenderer.invoke(HIVE_MANAGER.indexStatus),
  },

  // Hive manager-status bridge (slice 2b-2a) — a single push subscription,
  // mirroring the loop bridge's onStatus.
  manager: {
    onStatus: (handler: HiveManagerStatusHandler): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, e: HiveManagerStatusEvent): void => handler(e);
      ipcRenderer.on(HIVE_MANAGER.evtStatus, listener);
      return () => ipcRenderer.removeListener(HIVE_MANAGER.evtStatus, listener);
    },
  },
```

- [ ] **Step 7: Typecheck.** `rm -f *.tsbuildinfo && npm run typecheck` — expect PASS.
- [ ] **Step 8: Commit.**

```bash
git add src/preload/api.ts src/preload/index.ts
git commit -m "$(cat <<'EOF'
feat(hive): expose repo.reindex, index.status, manager.onStatus on the preload bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `useManagerStatus` hook

**Files:**
- Create: `src/renderer/src/lib/useManagerStatus.ts`

Mirror `useHiveLoop.ts`: guard `window.hive?.manager`, subscribe `manager.onStatus`, fetch `index.status()` on mount, refresh it on each status event, and expose `{ status, reindex }`. Keep it small. (No dedicated unit test — the hook is thin glue verified by the full typecheck; the existing renderer test stack covers components, not this hook in isolation.)

- [ ] **Step 1: Implement.** Create `src/renderer/src/lib/useManagerStatus.ts`:

```ts
import { useEffect, useState } from 'react'

import type { IndexStatus } from '../../../types/hive'

export interface ManagerStatusState {
  /** Per-repo index status, keyed by repo name. */
  status: Record<string, IndexStatus>
}

/**
 * Subscribe to manager-lane status pushes and the per-repo index-status map.
 * Refetches the map on every status event so the UI tracks the lane. Mirrors
 * `useHiveLoop`: guards the bridge, subscribes, cleans up on unmount.
 */
export function useManagerStatus(): ManagerStatusState & {
  reindex: (repo: string) => Promise<void>
} {
  const [status, setStatus] = useState<Record<string, IndexStatus>>({})

  useEffect(() => {
    const manager = window.hive?.manager
    const index = window.hive?.index
    if (!manager || !index) return
    const refresh = (): void => {
      void index.status().then(setStatus).catch(() => undefined)
    }
    refresh()
    const off = manager.onStatus(() => refresh())
    return () => { off() }
  }, [])

  return {
    status,
    reindex: async (repo) => {
      await window.hive?.repo?.reindex(repo)
      // Optimistically refresh; the status push will follow.
      const map = await window.hive?.index?.status().catch(() => undefined)
      if (map) setStatus(map)
    },
  }
}
```

- [ ] **Step 2: Typecheck.** `rm -f *.tsbuildinfo && npm run typecheck` — expect PASS.
- [ ] **Step 3: Commit.**

```bash
git add src/renderer/src/lib/useManagerStatus.ts
git commit -m "$(cat <<'EOF'
feat(hive): add useManagerStatus hook for the index-status surface

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Index-status surface in the Dock

**Files:**
- Modify: `src/renderer/src/components/AgentDock.tsx`
- Modify: `src/renderer/src/styles/ide.css`

Surface per-repo index status (`indexed ✓` / `indexing…` / `failed ↻`) plus a Re-index button, rendered in `RunPanel` only when connected (where the `loop-bar` lives). Repos come from the workspace store's existing `repos` selector — do NOT invent a new selector. Add `idx-*` CSS classes alongside the slice 2b-1 hive Dock styles.

- [ ] **Step 1 (AgentDock.tsx): import the hook + the repos selector.** Near the existing `useHiveLoop` / `useWorkspaceStore` imports, add:

```ts
import { useManagerStatus } from '../lib/useManagerStatus'
import type { IndexStatus } from '../../../types/hive'
```

(`useWorkspaceStore` is already imported.)

- [ ] **Step 2 (AgentDock.tsx): add the IndexPanel component.** Add this above `RunPanel`:

```tsx
// ---------------------------------------------------------------------------
// Repo index status (slice 2b-2a)
// ---------------------------------------------------------------------------

const INDEX_LABEL: Record<IndexStatus, string> = {
  indexed: 'indexed ✓',
  indexing: 'indexing…',
  failed: 'failed',
  unindexed: 'not indexed',
}

interface IndexPanelProps {
  repos: { name: string }[]
  status: Record<string, IndexStatus>
  reindex: (repo: string) => void
}

function IndexPanel({ repos, status, reindex }: IndexPanelProps) {
  if (repos.length === 0) return null
  return (
    <div className="idx-panel">
      <div className="idx-head">Repo index <span className="ct">{repos.length}</span></div>
      {repos.map((r) => {
        const s: IndexStatus = status[r.name] ?? 'unindexed'
        return (
          <div className="idx-row" key={r.name}>
            <span className="idx-name">{r.name}</span>
            <span className={`idx-state idx-state--${s}`}>{INDEX_LABEL[s]}</span>
            <button
              type="button"
              className="idx-reindex"
              title="Re-index"
              disabled={s === 'indexing'}
              onClick={() => reindex(r.name)}
            >
              ↻
            </button>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3 (AgentDock.tsx): thread the manager status into `RunPanel`.** `RunPanel` already takes `connected`. Add a `manager` prop and render `IndexPanel` after the `loop-bar` block. Update the `RunPanelProps` interface and the component:

```tsx
interface RunPanelProps {
  roster: Agent[]
  onOpenFile: OpenFile
  connected: boolean
  needsInput: Story[]
  loop: ReturnType<typeof useHiveLoop>
  manager: ReturnType<typeof useManagerStatus>
  repos: { name: string }[]
}

function RunPanel({ roster, onOpenFile, connected, needsInput, loop, manager, repos }: RunPanelProps) {
```

Then, immediately after the `connected && (<div className="loop-bar"> … </div>)` block inside `RunPanel`, add:

```tsx
      {connected && (
        <IndexPanel repos={repos} status={manager.status} reindex={(r) => void manager.reindex(r)} />
      )}
```

- [ ] **Step 4 (AgentDock.tsx): wire it from `Dock`.** In the `Dock` component, alongside `const loop = useHiveLoop()`, add:

```tsx
  const manager = useManagerStatus()
  const repos = useWorkspaceStore((s) => s.repos)
```

Then pass them in the `tab === 'run'` render of `RunPanel`:

```tsx
        {tab === 'run' && (
          <RunPanel
            roster={roster}
            onOpenFile={onOpenFile}
            connected={hiveConnection.state === 'connected'}
            needsInput={needsInput}
            loop={loop}
            manager={manager}
            repos={repos}
          />
        )}
```

- [ ] **Step 5 (ide.css): add the index-panel styles.** Append after the slice-2b-1 `.ni-actions { … }` rule (the "Hive loop bar + needs-input" section):

```css
/* ---------- Repo index status (slice 2b-2a) ---------- */
.idx-panel { padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 6px; }
.idx-head { font: 600 12px/1 var(--font-ui); color: var(--fg-2); display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.idx-head .ct { margin-left: auto; font: var(--t-meta); font-family: var(--font-mono); color: var(--fg-3); background: var(--bg-elevated); border-radius: 99px; padding: 1px 7px; }
.idx-row { display: flex; align-items: center; gap: 8px; }
.idx-name { font: var(--t-body-sm); color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.idx-state { margin-left: auto; font: var(--t-meta); color: var(--fg-3); white-space: nowrap; }
.idx-state--indexed { color: var(--status-running); }
.idx-state--indexing { color: var(--amber-300); }
.idx-state--failed { color: #ef4444; }
.idx-reindex { background: transparent; border: 1px solid var(--border-default); border-radius: var(--r-sm); color: var(--fg-2); cursor: pointer; width: 22px; height: 22px; line-height: 1; padding: 0; transition: border-color .14s, color .14s; }
.idx-reindex:hover:not(:disabled) { border-color: var(--border-strong); color: var(--fg-1); }
.idx-reindex:disabled { opacity: .4; cursor: default; }
```

> `--amber-300` and `--status-running` are existing tokens (used by `.ni-q` and `.hive-banner--ok`); `failed` uses a literal red since `--status-review` is blue.

- [ ] **Step 6: Typecheck + full test run.** `rm -f *.tsbuildinfo && npm run typecheck && npx vitest run` — expect PASS.
- [ ] **Step 7: Commit.**

```bash
git add src/renderer/src/components/AgentDock.tsx src/renderer/src/styles/ide.css
git commit -m "$(cat <<'EOF'
feat(hive): surface per-repo index status + re-index in the Dock

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Run the full check.** `rm -f *.tsbuildinfo && npm run typecheck && npx vitest run` — everything green.
- [ ] **Manual smoke (optional, not part of CI):** connect a project with ≥2 repos → repos auto-index → profiles appear under `.hive/index/<repo>.md` → Dock shows `indexed ✓`. Click ↻ on one repo → it flips to `indexing…` then back to `indexed ✓` with a refreshed `indexed_at`. Kill the app mid-index → on restart the repo (no profile yet) is re-enqueued.

## Spec → task coverage (2b-2a only)

- Read-only indexer run, cwd = repo, no worktree, no writes → Task 5 (prompts) + Task 8 (`makeIndexJob` cwd/buildSpec, no `createWorktree`).
- `onResult` runner extension (shared with 2b-2b) → Task 2 + Task 3.
- Manager lane = second runner + FIFO, serial, generic job, failure-continues (shared with 2b-2b) → Task 6.
- `RepoProfile` / `IndexStatus` / `HiveManagerStatusEvent` types, no enum changes → Task 1.
- Profile write contract `.hive/index/<repo>.md` (frontmatter `repo`/`indexed_at`/`commit?` + body) → Task 4 + Task 8.
- Auto-index on connect AND app start; manual reindex; `indexStatus` derivation (indexed/indexing/failed/unindexed) → Task 8.
- HEAD sha for `commit` via the existing git runner, omitted when unreachable → Task 8 (`headSha`).
- Manager status pushed to the renderer → Task 8 (`hiveSend(HIVE_MANAGER_EVENTS.status, …)`) + Task 9 (`manager.onStatus`).
- Reap the lane child + clear its queue on before-quit → Task 6 (`dispose`) + Task 8 (before-quit).
- IPC channels `ipc:hive:repo:reindex`, `ipc:hive:index:status`, `event:hive:manager:status` → Task 7 + Task 9 (parity verified).
- Index-status UI surface (`indexed ✓` / `indexing…` / `failed`) + Re-index button near the board → Task 10 + Task 11.

> Explicitly OUT of this plan (belongs to 2b-2b): requirement creation, `serializeRequirement`, the manager decompose prompt + `parsePlan`, `proposed` stories, the `proposed`/`decomposing` enum additions, approve/discard. The shared infra those will reuse (the `onResult` runner hook + the generic manager lane) IS delivered here.
