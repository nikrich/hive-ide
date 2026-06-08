# Hive Workspace Bootstrap + Story Authoring (Slice 2c) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a project's hive workspace automatically (IDE-managed under app data) and author stories from a UI modal — no hand-run scripts — and make a worker run against the repo named by the story's `team`.

**Architecture:** New small main-process units under `src/main/hive/run/` (`workspace.ts` for the `.hive/` dir tree, `story.ts` for slug/dedupe/build/write, `repo.ts` for team→repo resolution). Two new IPC channels + a `window.hive.workspace`/`window.hive.story` preload bridge. Renderer hooks: ensure+bind on project create, an "Initialize hive" Dock action, and a New-story modal. State changes render through the existing slice-1 watcher — no new board code.

**Tech Stack:** Electron main (Node, `node:fs/promises`), TypeScript, Vitest (node env for main, happy-dom for renderer), React. Reuses slice-1 `parseStory` and slice-2a `serializeStory`.

**Spec:** `docs/specs/2026-06-08-hive-workspace-and-story-authoring-slice2c-design.md`

**Conventions:**
- CI runs on **node 22** — verify with `fnm exec --using=22 <cmd>` (fnm has 22.22.2). Before `npm run typecheck`, run `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete` (tsc -b is incremental and masks errors otherwise).
- Single test file: `fnm exec --using=22 npx vitest run <path>`. Full suite: `fnm exec --using=22 npx vitest run`.
- No `any`. Main tests are `*.test.ts` (node env); renderer component tests use a `// @vitest-environment happy-dom` header + `@testing-library/react` (see `src/renderer/src/components/primitives/InlineEditable.test.tsx` for the pattern).
- **Confirm `git branch --show-current` is `feat/hive-workspace-story-ui-slice2c` before every commit.** Stage only the files each task names.

---

## File Structure

**Create:**
- `src/main/hive/run/workspace.ts` (+ `.test.ts`) — `workspaceDirFor`, `ensureWorkspace`.
- `src/main/hive/run/story.ts` (+ `.test.ts`) — `slugify`, `uniqueStoryId`, `buildStory`, `createStory`.
- `src/main/hive/run/repo.ts` (+ `.test.ts`) — `resolveRepoForStory` (team→repo, pure).
- `src/renderer/src/components/NewStoryModal.tsx` (+ `.test.tsx`) — the authoring form.

**Modify:**
- `src/types/hive.ts` — add `NewStoryFields`.
- `src/main/hive/run/handlers.ts` — add `ensure-workspace` + `create-story` channels; make `RunDeps.getRepoPath` story-aware; reorder `runStory`.
- `src/main/index.ts` — wire `ensureWorkspace`/`createStory` deps + `resolveRepoForStory`.
- `src/preload/api.ts` + `src/preload/index.ts` — `window.hive.workspace.ensure` + `window.hive.story.create`.
- `src/renderer/src/components/NewProjectModal.tsx` — ensure + bind workspace after create.
- `src/renderer/src/components/AgentDock.tsx` — Initialize-hive action + New-story button.

---

## Task 1: Shared `NewStoryFields` type

**Files:** Modify `src/types/hive.ts`

- [ ] **Step 1: Add the type**

At the end of `src/types/hive.ts`, append:

```ts
// ---------------------------------------------------------------------------
// Slice 2c — story authoring
// ---------------------------------------------------------------------------

/** Fields the New-story form collects. Shared renderer ↔ preload ↔ main. */
export interface NewStoryFields {
  title: string;
  /** Description / markdown body. */
  body: string;
  role: HiveRole;
  /** Team = a repo name in the active project. */
  team: string;
  acceptanceCriteria: string[];
}
```

- [ ] **Step 2: Typecheck**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck`
Expected: clean (type not yet referenced).

- [ ] **Step 3: Commit**

```bash
git add src/types/hive.ts
git commit -m "feat(hive): NewStoryFields shared type (slice 2c)"
```

---

## Task 2: Workspace bootstrap (`ensureWorkspace`)

**Files:** Create `src/main/hive/run/workspace.ts` + `src/main/hive/run/workspace.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/workspace.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { workspaceDirFor, ensureWorkspace } from './workspace';

let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'hive-ud-'));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('workspaceDirFor', () => {
  it('joins userData/hive-workspaces/<projectId>', () => {
    expect(workspaceDirFor('/ud', 'p1')).toBe('/ud/hive-workspaces/p1');
  });
});

describe('ensureWorkspace', () => {
  it('creates the .hive state tree + empty events.ndjson and returns the dir', async () => {
    const dir = await ensureWorkspace(userData, 'p1');
    expect(dir).toBe(join(userData, 'hive-workspaces', 'p1'));
    for (const sub of ['requirements', 'stories', 'agents']) {
      const s = await stat(join(dir, '.hive', 'state', sub));
      expect(s.isDirectory()).toBe(true);
    }
    expect(await readFile(join(dir, '.hive', 'events.ndjson'), 'utf8')).toBe('');
  });

  it('is idempotent and does not truncate an existing events.ndjson', async () => {
    const dir = await ensureWorkspace(userData, 'p1');
    await writeFile(join(dir, '.hive', 'events.ndjson'), '{"x":1}\n', 'utf8');
    const again = await ensureWorkspace(userData, 'p1');
    expect(again).toBe(dir);
    expect(await readFile(join(dir, '.hive', 'events.ndjson'), 'utf8')).toBe('{"x":1}\n');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/workspace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/workspace.ts`:

```ts
/**
 * IDE-managed hive workspace bootstrap (slice 2c). A project's workspace lives
 * under app data at `<userData>/hive-workspaces/<projectId>/` and holds the
 * `.hive/` state tree + events log + worktrees. Pure-ish: takes `userDataPath`
 * so it's testable against a temp dir; the IPC layer passes
 * `app.getPath('userData')`.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Absolute path of a project's IDE-managed hive workspace. */
export function workspaceDirFor(userDataPath: string, projectId: string): string {
  return join(userDataPath, 'hive-workspaces', projectId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotently create the `.hive/` tree (state/{requirements,stories,agents}
 * + an empty events.ndjson) under the project's workspace dir. Never truncates
 * an existing events.ndjson. Returns the workspace dir.
 */
export async function ensureWorkspace(userDataPath: string, projectId: string): Promise<string> {
  const dir = workspaceDirFor(userDataPath, projectId);
  const stateRoot = join(dir, '.hive', 'state');
  for (const sub of ['requirements', 'stories', 'agents']) {
    await mkdir(join(stateRoot, sub), { recursive: true });
  }
  const eventsPath = join(dir, '.hive', 'events.ndjson');
  if (!(await exists(eventsPath))) {
    await writeFile(eventsPath, '', 'utf8');
  }
  return dir;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/workspace.ts src/main/hive/run/workspace.test.ts
git commit -m "feat(hive): IDE-managed workspace bootstrap (slice 2c)"
```

---

## Task 3: Story authoring (slug / dedupe / build / write)

**Files:** Create `src/main/hive/run/story.ts` + `src/main/hive/run/story.test.ts`

Reuses slice-2a `serializeStory` (`src/main/hive/run/serialize.ts`) and slice-1
`parseStory` (`src/main/hive/parse.ts`). The story frontmatter format is the
slice-1 contract; `serializeStory` already round-trips through `parseStory`.

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/story.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { slugify, uniqueStoryId, buildStory, createStory } from './story';
import { parseStory } from '../parse';
import type { NewStoryFields } from '../../../types/hive';

const fields: NewStoryFields = {
  title: 'Add login form',
  body: 'Implement the login form.',
  role: 'senior',
  team: 'web',
  acceptanceCriteria: ['Validates email', 'Submits to /login'],
};

describe('slugify', () => {
  it('lowercases, trims, replaces non-alphanumerics with single dashes', () => {
    expect(slugify('Add login form')).toBe('add-login-form');
    expect(slugify('  Fix: the THING!! ')).toBe('fix-the-thing');
    expect(slugify('a/b\\c')).toBe('a-b-c');
  });
  it('falls back to "story" for an empty/symbol-only title', () => {
    expect(slugify('')).toBe('story');
    expect(slugify('!!!')).toBe('story');
  });
});

describe('uniqueStoryId', () => {
  it('returns the base when free', () => {
    expect(uniqueStoryId('add-login', new Set())).toBe('add-login');
  });
  it('appends -2, -3 on collision', () => {
    expect(uniqueStoryId('add-login', new Set(['add-login']))).toBe('add-login-2');
    expect(uniqueStoryId('add-login', new Set(['add-login', 'add-login-2']))).toBe('add-login-3');
  });
});

describe('buildStory', () => {
  it('builds a pending story round-tripping through parseStory', () => {
    const s = buildStory(fields, 'add-login-form', '2026-06-08T00:00:00Z');
    expect(s.status).toBe('pending');
    expect(s.team).toBe('web');
    expect(s.role).toBe('senior');
    expect(s.acceptanceCriteria).toEqual(['Validates email', 'Submits to /login']);
    expect(s.createdAt).toBe('2026-06-08T00:00:00Z');
    expect(s.updatedAt).toBe('2026-06-08T00:00:00Z');
    // round-trips via the slice-2a serializer used by createStory.
    expect(s.id).toBe('add-login-form');
  });
});

describe('createStory', () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'hive-ws-'));
    await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
    await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it('writes stories/<id>.md, appends a created event, returns the id', async () => {
    const id = await createStory(ws, fields, '2026-06-08T00:00:00Z');
    expect(id).toBe('add-login-form');
    const raw = await readFile(join(ws, '.hive', 'state', 'stories', 'add-login-form.md'), 'utf8');
    const parsed = parseStory(raw, id);
    expect(parsed.title).toBe('Add login form');
    expect(parsed.status).toBe('pending');
    expect(parsed.team).toBe('web');
    const events = await readFile(join(ws, '.hive', 'events.ndjson'), 'utf8');
    expect(events).toContain('"event":"created"');
  });

  it('de-dupes the id when a same-titled story exists', async () => {
    await createStory(ws, fields, 't0');
    const id2 = await createStory(ws, fields, 't1');
    expect(id2).toBe('add-login-form-2');
    const names = await readdir(join(ws, '.hive', 'state', 'stories'));
    expect(names).toContain('add-login-form.md');
    expect(names).toContain('add-login-form-2.md');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/story.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/story.ts`:

```ts
/**
 * Story authoring (slice 2c): turn New-story form fields into a slice-1 story
 * file + a `created` event. Pure helpers (slugify / uniqueStoryId / buildStory)
 * plus a thin writer (createStory) that reads existing ids to de-dupe.
 */

import { appendFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HiveStory, NewStoryFields } from '../../../types/hive';
import { serializeStory, eventLine } from './serialize';

/** Title → filename-stem slug. Empty/symbol-only → 'story'. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'story' : slug;
}

/** Unique id from a base slug given the existing ids (append -2/-3 on clash). */
export function uniqueStoryId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Build a pending HiveStory from form fields + a resolved id + timestamp. */
export function buildStory(fields: NewStoryFields, id: string, now: string): HiveStory {
  return {
    id,
    title: fields.title.trim(),
    status: 'pending',
    role: fields.role,
    points: 0,
    team: fields.team,
    dependsOn: [],
    acceptanceCriteria: fields.acceptanceCriteria,
    createdAt: now,
    updatedAt: now,
    body: fields.body,
  };
}

/** Existing story ids (filename stems) under <ws>/.hive/state/stories/. */
async function existingStoryIds(workspacePath: string): Promise<Set<string>> {
  try {
    const names = await readdir(join(workspacePath, '.hive', 'state', 'stories'));
    return new Set(names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
  } catch {
    return new Set();
  }
}

/**
 * Write a new story file (de-duped id) + append a `created` event. Returns the
 * new story id. Throws on fs failure — the IPC handler surfaces it.
 */
export async function createStory(
  workspacePath: string,
  fields: NewStoryFields,
  now: string,
): Promise<string> {
  const existing = await existingStoryIds(workspacePath);
  const id = uniqueStoryId(slugify(fields.title), existing);
  const story = buildStory(fields, id, now);

  await writeFile(
    join(workspacePath, '.hive', 'state', 'stories', `${id}.md`),
    serializeStory(story),
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

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/story.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/story.ts src/main/hive/run/story.test.ts
git commit -m "feat(hive): story authoring (slug/dedupe/build/write) (slice 2c)"
```

---

## Task 4: Team→repo resolver

**Files:** Create `src/main/hive/run/repo.ts` + `src/main/hive/run/repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/hive/run/repo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { resolveRepoForStory } from './repo';

const repos = [
  { name: 'web', path: '/r/web', isGitRepo: true },
  { name: 'api', path: '/r/api', isGitRepo: true },
];

describe('resolveRepoForStory', () => {
  it('matches the repo whose name equals the story team', () => {
    expect(resolveRepoForStory('api', repos)).toBe('/r/api');
  });
  it('falls back to the first repo when team is unknown', () => {
    expect(resolveRepoForStory('nope', repos)).toBe('/r/web');
  });
  it('falls back to the first repo when team is empty', () => {
    expect(resolveRepoForStory('', repos)).toBe('/r/web');
  });
  it('returns null when there are no repos', () => {
    expect(resolveRepoForStory('web', [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/hive/run/repo.ts`:

```ts
/**
 * Resolve which repo a worker runs against (slice 2c). A story names a `team`;
 * the project's repos are the teams. Match by name; fall back to the first repo
 * so a stale/unknown team never wedges a run. Pure.
 */

import type { Repo } from '../../../types/workspace';

export function resolveRepoForStory(team: string, repos: readonly Repo[]): string | null {
  if (repos.length === 0) return null;
  const match = repos.find((r) => r.name === team);
  return (match ?? repos[0]).path;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/repo.ts src/main/hive/run/repo.test.ts
git commit -m "feat(hive): team→repo resolver for story runs (slice 2c)"
```

---

## Task 5: Make `runStory` team-aware (repo from story.team)

**Files:** Modify `src/main/hive/run/handlers.ts` + `src/main/hive/run/handlers.test.ts`

Today `RunDeps.getRepoPath: () => string | null` is parameterless and `runStory`
calls it before fetching the story. Make it `(story) => string | null` and reorder
`runStory` to fetch the story first.

- [ ] **Step 1: Update the failing test expectations**

In `src/main/hive/run/handlers.test.ts`, the `deps()` factory has
`getRepoPath` (or the run wiring uses a repo path). Change the fake to a
story-aware signature and add an assertion. Find the `getRepoPath` field in the
`deps()` factory and change it to:

```ts
    getRepoPath: vi.fn((_story) => '/repo'),
```

Add a test asserting the story is passed:

```ts
  it('resolves the repo from the fetched story', async () => {
    const getRepoPath = vi.fn(() => '/repo');
    const d = deps({ getRepoPath });
    await runStory(d, 'AUTH-3');
    expect(getRepoPath).toHaveBeenCalledWith(expect.objectContaining({ id: 'AUTH-3' }));
  });
```

(If `deps()` already imports the `story` fixture, reuse it; the existing fixture's
`id` is `AUTH-3`.)

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Expected: FAIL — `getRepoPath` is called with no args / with a story it doesn't expect.

- [ ] **Step 3: Implement**

In `src/main/hive/run/handlers.ts`:

Change the `RunDeps` interface field:

```ts
  getRepoPath: (story: HiveStory) => string | null;
```

In `runStory`, reorder so the story is fetched before the repo is resolved.
Replace the opening guards (the `getWorkspacePath`/`getRepoPath`/`getStory`
block) with:

```ts
  const workspacePath = deps.getWorkspacePath();
  if (!workspacePath) throw new Error('No connected hive workspace');

  const story = await deps.getStory(storyId);
  if (!story) throw new Error(`Story not found: ${storyId}`);

  const repoPath = deps.getRepoPath(story);
  if (!repoPath) throw new Error('No repo for story (project has no repos)');
```

(Keep the `runInFlight`/`isBusy` busy-guard exactly as-is at the top, and keep
the rest of `runStory` — `newRunId`, `createWorktree`, `writeRunStart`, prompts,
runner — unchanged. `createWorktree` already receives `repoPath`.)

If an existing slice-2a test in `handlers.test.ts` asserts the old combined
`No connected hive workspace / repo` message, or relies on `getRepoPath` being
called before `getStory`, update it to the new order (workspace → story → repo)
and the split messages above. Re-run the full file after.

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/handlers.ts src/main/hive/run/handlers.test.ts
git commit -m "feat(hive): resolve worker repo from story team (slice 2c)"
```

---

## Task 6: IPC channels for ensure-workspace + create-story

**Files:** Modify `src/main/hive/run/handlers.ts` + `src/main/hive/run/handlers.test.ts`

Add two invoke channels. Keep them dependency-injected so they're testable
without `ipcMain`/`app`.

- [ ] **Step 1: Write the failing test**

In `src/main/hive/run/handlers.test.ts`, add a describe block. The new helpers
are pure-ish functions `ensureWorkspaceFor(deps2, projectId)` and
`createStoryFor(deps2, workspacePath, fields)` that the IPC handlers call.

```ts
import { ensureWorkspaceFor, createStoryFor, type AuthoringDeps } from './handlers';

describe('authoring orchestration', () => {
  it('ensureWorkspaceFor calls ensureWorkspace + points the reader', async () => {
    const ensureWorkspace = vi.fn(async () => '/ud/hive-workspaces/p1');
    const setReaderWorkspace = vi.fn(async () => {});
    const deps2: AuthoringDeps = {
      userDataPath: () => '/ud',
      ensureWorkspace,
      setReaderWorkspace,
      createStory: vi.fn(async () => 'sid'),
      now: () => 't0',
    };
    const out = await ensureWorkspaceFor(deps2, 'p1');
    expect(out).toEqual({ workspacePath: '/ud/hive-workspaces/p1' });
    expect(ensureWorkspace).toHaveBeenCalledWith('/ud', 'p1');
    expect(setReaderWorkspace).toHaveBeenCalledWith('/ud/hive-workspaces/p1');
  });

  it('createStoryFor writes the story and returns its id', async () => {
    const createStory = vi.fn(async () => 'add-login');
    const deps2: AuthoringDeps = {
      userDataPath: () => '/ud',
      ensureWorkspace: vi.fn(async () => '/ws'),
      setReaderWorkspace: vi.fn(async () => {}),
      createStory,
      now: () => 't0',
    };
    const fields = { title: 'Add login', body: '', role: 'senior' as const, team: 'web', acceptanceCriteria: [] };
    const out = await createStoryFor(deps2, '/ws', fields);
    expect(out).toEqual({ storyId: 'add-login' });
    expect(createStory).toHaveBeenCalledWith('/ws', fields, 't0');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Expected: FAIL — `ensureWorkspaceFor`/`createStoryFor`/`AuthoringDeps` not exported.

- [ ] **Step 3: Implement**

In `src/main/hive/run/handlers.ts`:

Add to the channel constants:

```ts
export const HIVE_AUTHORING_CHANNELS = {
  ensureWorkspace: 'ipc:hive:ensure-workspace',
  createStory: 'ipc:hive:create-story',
} as const;
```

Add the deps + orchestration functions (import `NewStoryFields` from
`../../../types/hive`):

```ts
export interface AuthoringDeps {
  userDataPath: () => string;
  ensureWorkspace: (userDataPath: string, projectId: string) => Promise<string>;
  /** Point the slice-1 reader at the workspace so the board goes live. */
  setReaderWorkspace: (workspacePath: string) => Promise<void>;
  createStory: (workspacePath: string, fields: NewStoryFields, now: string) => Promise<string>;
  now: () => string;
}

export async function ensureWorkspaceFor(
  deps: AuthoringDeps,
  projectId: string,
): Promise<{ workspacePath: string }> {
  const workspacePath = await deps.ensureWorkspace(deps.userDataPath(), projectId);
  await deps.setReaderWorkspace(workspacePath);
  return { workspacePath };
}

export async function createStoryFor(
  deps: AuthoringDeps,
  workspacePath: string,
  fields: NewStoryFields,
): Promise<{ storyId: string }> {
  const storyId = await deps.createStory(workspacePath, fields, deps.now());
  return { storyId };
}

export function registerHiveAuthoringHandlers(deps: AuthoringDeps): () => void {
  ipcMain.handle(HIVE_AUTHORING_CHANNELS.ensureWorkspace, (_e, args: { projectId: string }) =>
    ensureWorkspaceFor(deps, args.projectId),
  );
  ipcMain.handle(HIVE_AUTHORING_CHANNELS.createStory, (_e, args: { workspacePath: string; fields: NewStoryFields }) =>
    createStoryFor(deps, args.workspacePath, args.fields),
  );
  return () => {
    ipcMain.removeHandler(HIVE_AUTHORING_CHANNELS.ensureWorkspace);
    ipcMain.removeHandler(HIVE_AUTHORING_CHANNELS.createStory);
  };
}
```

(`ipcMain` is already imported in this file for `registerHiveRunHandlers`.)

- [ ] **Step 4: Run to verify it passes**

Run: `fnm exec --using=22 npx vitest run src/main/hive/run/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hive/run/handlers.ts src/main/hive/run/handlers.test.ts
git commit -m "feat(hive): ensure-workspace + create-story orchestration + IPC (slice 2c)"
```

---

## Task 7: Wire authoring + team-aware repo into main

**Files:** Modify `src/main/index.ts`

No new unit test (integration wiring); verified by typecheck + full suite + the
manual e2e (Task 11). Read the existing slice-2a run wiring first (the
`registerHiveRunHandlers({...})` block and `activeRepoPath`).

- [ ] **Step 1: Imports + team-aware repo**

In `src/main/index.ts`, add imports next to the existing hive-run imports:

```ts
import {
  registerHiveAuthoringHandlers,
} from './hive/run/handlers';
import { ensureWorkspace } from './hive/run/workspace';
import { createStory } from './hive/run/story';
import { resolveRepoForStory } from './hive/run/repo';
```

(`registerHiveRunHandlers`, `createRunner`, `createWt`, `hasCommit`,
`writeRunStart`, `writeRunFinish`, `parseStory`, `hiveReader`, `GitRunner` are
already imported from slice 2a — extend the existing `./hive/run/handlers`
import rather than duplicating.)

Add a module-level teardown var next to `teardownHiveRunHandlers`:

```ts
let teardownHiveAuthoringHandlers: (() => void) | undefined;
```

Replace the existing `activeRepoPath` and the `getRepoPath: activeRepoPath` dep
with a story-aware resolver. Define a helper that reads the active project's
repos and resolves by team:

```ts
  const activeRepos = (): import('../types/workspace').Repo[] => {
    const s = store?.get();
    const proj = s && s.lastProjectId ? s.projects[s.lastProjectId] : null;
    return proj?.repos ?? [];
  };
```

And change the dep in the `registerHiveRunHandlers({...})` call:

```ts
    getRepoPath: (story) => resolveRepoForStory(story.team, activeRepos()),
```

(Delete the old `const activeRepoPath = () => {...}` and its `getRepoPath:
activeRepoPath` usage.)

- [ ] **Step 2: Register authoring handlers**

Right after the `teardownHiveRunHandlers = registerHiveRunHandlers({...});`
block, add:

```ts
  teardownHiveAuthoringHandlers = registerHiveAuthoringHandlers({
    userDataPath: () => app.getPath('userData'),
    ensureWorkspace,
    setReaderWorkspace: async (workspacePath) => {
      await hiveReader.setWorkspace(workspacePath);
    },
    createStory,
    now: () => new Date().toISOString(),
  });
```

- [ ] **Step 3: Teardown on quit**

Where the other teardowns run (next to `teardownHiveRunHandlers?.();`), add:

```ts
  teardownHiveAuthoringHandlers?.();
```

- [ ] **Step 4: Typecheck + full suite**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck && fnm exec --using=22 npx vitest run`
Expected: typecheck clean; full suite passes (report count).

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(hive): wire authoring handlers + team-aware repo in main (slice 2c)"
```

---

## Task 8: Preload bridge (`window.hive.workspace` + `window.hive.story`)

**Files:** Modify `src/preload/api.ts` + `src/preload/index.ts`

Mirror the existing `run`/`orchestration` bridge style. Read how `run` is
declared in `api.ts` (the `HiveRunBridge` interface added to `HiveBridge`) and
how it's implemented in `index.ts`.

- [ ] **Step 1: Add bridge types to `api.ts`**

In `src/preload/api.ts`, add two interfaces and add them to `HiveBridge`:

```ts
export interface HiveWorkspaceBridge {
  ensure(projectId: string): Promise<{ workspacePath: string }>;
}

export interface HiveStoryBridge {
  create(
    workspacePath: string,
    fields: import('../types/hive').NewStoryFields,
  ): Promise<{ storyId: string }>;
}
```

Add to the `HiveBridge` interface (next to `run: HiveRunBridge;`):

```ts
  workspace: HiveWorkspaceBridge;
  story: HiveStoryBridge;
```

- [ ] **Step 2: Implement in `index.ts`**

In `src/preload/index.ts`, add channel constants near `HIVE_RUN`:

```ts
const HIVE_AUTHORING = {
  ensureWorkspace: 'ipc:hive:ensure-workspace',
  createStory: 'ipc:hive:create-story',
} as const;
```

Add to the `api` object (next to `run: {...}`):

```ts
  workspace: {
    ensure: (projectId: string) =>
      ipcRenderer.invoke(HIVE_AUTHORING.ensureWorkspace, { projectId }),
  },
  story: {
    create: (workspacePath: string, fields: import('../types/hive').NewStoryFields) =>
      ipcRenderer.invoke(HIVE_AUTHORING.createStory, { workspacePath, fields }),
  },
```

- [ ] **Step 3: Typecheck + full suite**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck && fnm exec --using=22 npx vitest run`
Expected: clean + green.

- [ ] **Step 4: Commit**

```bash
git add src/preload/api.ts src/preload/index.ts
git commit -m "feat(hive): preload workspace.ensure + story.create bridge (slice 2c)"
```

---

## Task 9: Auto-create + bind workspace on project create

**Files:** Modify `src/renderer/src/components/NewProjectModal.tsx`

After `createProject` + repos are added, ensure the workspace, bind it on the
project, and point the reader so the board goes live. Read the current
`handleCreate` (it calls `createProject(trimmedName)` then `addRepoToProject`
per folder).

- [ ] **Step 1: Pull the bind action + project from the store**

Near the existing `const createProject = useWorkspaceStore((s) => s.createProject)`,
add:

```ts
  const setHiveWorkspacePath = useWorkspaceStore((s) => s.setHiveWorkspacePath)
```

- [ ] **Step 2: Ensure + bind after create**

`createProject` returns the new `Project` (it does — `createProject: (name) => Project`).
Update `handleCreate` to capture it and ensure the workspace:

```ts
  const handleCreate = useCallback(async () => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const project = createProject(trimmedName)
      for (const folder of pending) {
        await addRepoToProject(folder.path)
      }
      // Auto-create + bind the IDE-managed hive workspace so the board is live.
      try {
        const { workspacePath } = await window.hive.workspace.ensure(project.id)
        setHiveWorkspacePath(workspacePath)
        await window.hive.orchestration.setWorkspace(workspacePath)
      } catch (wsErr) {
        // Non-fatal: the project still exists; hive can be initialized later
        // from the Dock. Surface but don't block project creation.
        // eslint-disable-next-line no-console
        console.error('hive workspace init failed', wsErr)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create project')
      setBusy(false)
    }
  }, [addRepoToProject, canCreate, createProject, onClose, pending, setHiveWorkspacePath, trimmedName])
```

(Confirm `window.hive.orchestration.setWorkspace` exists in the preload bridge —
it does, from slice 1. It points the reader and returns the bundle.)

- [ ] **Step 3: Typecheck + full suite**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck && fnm exec --using=22 npx vitest run`
Expected: clean + green.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/NewProjectModal.tsx
git commit -m "feat(hive): auto-create + bind workspace on project create (slice 2c)"
```

---

## Task 10: New-story modal + Dock entry points

**Files:** Create `src/renderer/src/components/NewStoryModal.tsx` + `.test.tsx`; Modify `src/renderer/src/components/AgentDock.tsx`

- [ ] **Step 1: Write the failing modal test**

Create `src/renderer/src/components/NewStoryModal.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { NewStoryModal } from './NewStoryModal'

afterEach(cleanup)

const repos = [
  { name: 'web', path: '/r/web', isGitRepo: true },
  { name: 'api', path: '/r/api', isGitRepo: true },
]

describe('NewStoryModal', () => {
  it('disables Create until a title is entered', () => {
    render(<NewStoryModal repos={repos} onClose={() => {}} onCreate={vi.fn()} />)
    const create = screen.getByRole('button', { name: /create story/i }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Add login' } })
    expect(create.disabled).toBe(false)
  })

  it('submits the collected fields', () => {
    const onCreate = vi.fn()
    render(<NewStoryModal repos={repos} onClose={() => {}} onCreate={onCreate} />)
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Add login' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'do it' } })
    fireEvent.click(screen.getByRole('button', { name: /create story/i }))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Add login', body: 'do it', team: 'web', role: expect.any(String) }),
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `fnm exec --using=22 npx vitest run src/renderer/src/components/NewStoryModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the modal**

Create `src/renderer/src/components/NewStoryModal.tsx`:

```tsx
import { useState } from 'react'

import type { HiveRole, NewStoryFields } from '../../../types/hive'
import type { Repo } from '../../../types/workspace'
import { Btn } from './primitives'

const ROLES: readonly HiveRole[] = [
  'manager', 'tech-lead', 'senior', 'intermediate', 'junior', 'qa',
]

export interface NewStoryModalProps {
  repos: readonly Repo[]
  onClose: () => void
  onCreate: (fields: NewStoryFields) => void
}

/**
 * Author a hive story from the UI (slice 2c). Collects title, description,
 * role, team (a project repo), and an add/remove acceptance-criteria list.
 * Submit hands `NewStoryFields` to the caller (which calls
 * `window.hive.story.create`); the slice-1 watcher then renders the card.
 */
export function NewStoryModal({ repos, onClose, onCreate }: NewStoryModalProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [role, setRole] = useState<HiveRole>('senior')
  const [team, setTeam] = useState(repos[0]?.name ?? '')
  const [criteria, setCriteria] = useState<string[]>([''])

  const canCreate = title.trim() !== '' && team !== ''

  const submit = (): void => {
    if (!canCreate) return
    onCreate({
      title: title.trim(),
      body,
      role,
      team,
      acceptanceCriteria: criteria.map((c) => c.trim()).filter((c) => c !== ''),
    })
  }

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div
        className="cmd new-story-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-story-title"
      >
        <h2 id="new-story-title" style={{ font: 'var(--t-h3)', margin: '0 0 12px' }}>
          New story
        </h2>

        <label style={{ display: 'block', marginBottom: 10 }}>
          <div className="field-label">Title</div>
          <input
            aria-label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>

        <label style={{ display: 'block', marginBottom: 10 }}>
          <div className="field-label">Description</div>
          <textarea
            aria-label="Description"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
          <label style={{ flex: 1 }}>
            <div className="field-label">Role</div>
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as HiveRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1 }}>
            <div className="field-label">Team (repo)</div>
            <select aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}>
              {repos.map((r) => (
                <option key={r.path} value={r.name}>{r.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="field-label">Acceptance criteria</div>
        {criteria.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              aria-label={`Acceptance criterion ${i + 1}`}
              value={c}
              onChange={(e) =>
                setCriteria((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
              }
              style={{ flex: 1 }}
            />
            <Btn kind="ghost" sm icon="x" onClick={() =>
              setCriteria((prev) => (prev.length === 1 ? [''] : prev.filter((_, j) => j !== i)))
            }>{''}</Btn>
          </div>
        ))}
        <Btn kind="ghost" sm icon="plus" onClick={() => setCriteria((prev) => [...prev, ''])}>
          Add criterion
        </Btn>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="cta" disabled={!canCreate} onClick={submit}>Create story</Btn>
        </div>
      </div>
    </div>
  )
}

export default NewStoryModal
```

Note: `Btn`'s `disabled` prop already exists (slice 2a used it). If `Btn` does
NOT support `disabled`, fall back to a native `<button>` for the Create action;
check `src/renderer/src/components/primitives/Btn.tsx` first — it does support
`disabled`.

- [ ] **Step 4: Run to verify the modal passes**

Run: `fnm exec --using=22 npx vitest run src/renderer/src/components/NewStoryModal.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire entry points in AgentDock**

In `src/renderer/src/components/AgentDock.tsx`:

Read the active project's repos + workspace path + create the story. The Dock
already has `hiveConnection`. Add store access at the top of `Dock`:

```ts
  const project = useWorkspaceStore((s) => s.project)
  const setHiveWorkspacePath = useWorkspaceStore((s) => s.setHiveWorkspacePath)
  const [showNewStory, setShowNewStory] = useState(false)
```

(Import `useWorkspaceStore` if not already imported, and `NewStoryModal`.)

Add an **Initialize hive** button in the `no-workspace` block (next to the
existing "Connect…"):

```tsx
{hiveConnection.state === 'no-workspace' && (
  <div className="hive-connect">
    {/* existing Connect… affordance stays */}
    <button
      type="button"
      className="hive-connect-btn"
      disabled={project === null}
      onClick={async () => {
        if (!project) return
        try {
          const { workspacePath } = await window.hive.workspace.ensure(project.id)
          setHiveWorkspacePath(workspacePath)
          await window.hive.orchestration.setWorkspace(workspacePath)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('initialize hive failed', err)
        }
      }}
    >
      Initialize hive
    </button>
  </div>
)}
```

Add a **+ New story** button on the board header (visible only when connected),
and render the modal. Near the `MiniBoard` render (the `tab === 'board'` branch):

```tsx
{tab === 'board' && (
  <>
    {hiveConnection.state === 'connected' && (
      <div style={{ padding: '8px 12px' }}>
        <Btn kind="outline" sm icon="plus" onClick={() => setShowNewStory(true)}>
          New story
        </Btn>
      </div>
    )}
    <MiniBoard board={board} onOpenFile={onOpenFile} run={runControl} />
  </>
)}

{showNewStory && project && hiveConnection.state === 'connected' && (
  <NewStoryModal
    repos={project.repos}
    onClose={() => setShowNewStory(false)}
    onCreate={async (fields) => {
      setShowNewStory(false)
      try {
        await window.hive.story.create(hiveConnection.path, fields)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('create story failed', err)
      }
    }}
  />
)}
```

(`hiveConnection.path` is present on the `connected` variant. The created story
appears via the slice-1 watcher — no manual refresh.)

- [ ] **Step 6: Typecheck + full suite**

Run: `find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete && fnm exec --using=22 npm run typecheck && fnm exec --using=22 npx vitest run`
Expected: clean + green (report count).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/NewStoryModal.tsx src/renderer/src/components/NewStoryModal.test.tsx src/renderer/src/components/AgentDock.tsx
git commit -m "feat(hive): New-story modal + Initialize-hive Dock entry points (slice 2c)"
```

---

## Task 11: Full verification + manual end-to-end

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

1. `npm run dev`. **New Project** → name it, add a git repo or two → Create.
2. Open the project; the Agent Dock board should be **connected + empty** (no
   "Connect a workspace" prompt — it was auto-created at
   `<userData>/hive-workspaces/<projectId>/`).
3. Board tab → **New story** → fill Title, Description, Role, **Team** (pick a
   repo), add an acceptance criterion → **Create story**. The card appears
   **Pending** without a manual refresh.
4. Click **Run** on it → the worktree is cut from the **team's** repo (verify
   `<workspace>/.hive/worktrees/<storyId>` and the branch is on that repo).
5. Quit + relaunch → the project reconnects its workspace and the story persists.
6. For an existing project with no workspace: the Dock shows **Initialize hive**
   → click → board goes connected + empty.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore(hive): slice-2c verification fixups"
```
(Skip if nothing changed.)

---

## Notes for the executor

- **The slice-1 watcher renders everything.** You never push board updates —
  writing `stories/<id>.md` (Task 3) and pointing the reader (Task 6/7) is what
  makes cards appear. Keep `serializeStory` round-trip-clean against `parseStory`.
- **Workspace is IDE-managed.** Never write `.hive/` into the user's repo; it
  lives under `<userData>/hive-workspaces/<projectId>/`. The worker's worktree is
  still cut from the project's repo (resolved by team).
- **`getRepoPath` is now story-aware** (Task 5) — don't revert it to parameterless
  when wiring main (Task 7).
- **Don't invent store actions** — `createProject` returns the `Project`,
  `setHiveWorkspacePath` binds + persists it, and `window.hive.orchestration.setWorkspace`
  points the reader. All exist already.
