# Hive E2E Suite (Playwright + Electron) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A committed Playwright e2e suite that launches the built Electron app against throwaway fixture `.hive` workspaces and verifies the orchestration surface + shipped parity features, locally (`npm run e2e`) and in CI.

**Architecture:** One product hook (`HIVE_USER_DATA_DIR` env override for `app.setPath('userData')`) makes every test hermetic. A fixture factory fabricates a git repo + `.hive` tree per test; tests mutate those files mid-run to exercise the real chokidar→IPC→store pipeline. Playwright's `_electron.launch` drives the built app (`out/`); a console listener fails tests on uncaught renderer errors.

**Tech Stack:** Playwright Test (`@playwright/test` + `playwright` for `_electron`), Electron, Node `fs`/`child_process`. Spec: `docs/specs/2026-06-10-hive-e2e-playwright-design.md`.

**Worktree:** `/Users/jannik/development/nikrich/hive-ide/.claude/worktrees/feat-hive-e2e` (branch `worktree-feat-hive-e2e`, based on v0.4.0 main). All paths relative to this root. Baseline: `npm test` 774 passing, typecheck clean.

**Key facts (verified, with sources):**
- `package.json` `main` = `out/main/index.js`; `npm run build` = `tsc -b --noEmit && electron-vite build` → emits `out/{main,preload,renderer}`. With `ELECTRON_RENDERER_URL` unset, the window loads `out/renderer/index.html` and does NOT open devtools (`src/main/index.ts:97,201-206`).
- Vitest only includes `src/**/*.test.{ts,tsx}` (`vitest.config.ts:5`) — `e2e/**/*.spec.ts` cannot collide.
- Safe userData-override insertion point: `src/main/index.ts` immediately after line 97 (`const isDev = …`); every `app.getPath('userData')` consumer runs inside `app.whenReady()` (PersistedStateStore at ~line 212, SettingsStore ~line 221).
- Persisted state file: `<userData>/workspace.json`, schema v6 (`src/main/state/migrate.ts` `defaults()`); project entry shape `{id, name, repos:[{name,path,isGitRepo}], createdAt, lastOpenedAt, hiveWorkspacePath, expandedPaths}`; recents entry `{id, name, repoCount, lastOpenedAt}`. Boot tolerates a project without a session layout (`(session.openTabs ?? []).map` since #55).
- Answer flow: `ipc:hive:answer-question` → flips story `needs-input`→`pending`, appends `## Prior question / ## Answer` to the story body, deletes `.hive/state/questions/<storyId>.md`, appends `{"event":"answered"}` to `events.ndjson` (`src/main/hive/run/question.ts:36-64`). The Dock card needs story `status: needs-input`; question text comes via `event:hive:run:question` push or the questions list (`ipc:hive:questions:list`) — the card renders with empty `.ni-q` if no question text is available; textarea aria-label `Answer for <storyId>`; button text `Send answer`.
- Approval flow: `ipc:hive:requirement:approve` → proposed stories (parentRequirement === reqId) flip to `pending`, requirement flips `decomposed`→`in-flight`, `{"event":"approved"}` appended (`src/main/hive/manager/approve.ts:46-70`). Requirement cards render in the Dock Run tab when connected; buttons "Approve plan" / "Discard"; proposed list shows only while `status === 'decomposed'`.
- Selector inventory: `.hive-banner.hive-banner--ok` ("Connected · <path>"), `button.dock-tab` (Run/Stories/Chat), board `.mini-col`/`.ch`/`.scard`/`.sid`/`.stt`, roster `.agent-row`, needs-input `.ni-card`/`.ni-sid`/`.ni-q` + `textarea[aria-label="Answer for <id>"]`, requirements `.req-card`/`.req-id`/`.req-pill`/`.req-pstory`, chat `input[placeholder*="Message the orchestrator"]` + `.chat .msg`, hunk strip `button[aria-label="Stage hunk N"]`/`"Unstage hunk N"` + `.hunkbar-row`, search `[aria-label="Search query"]`/`"Include match <file>:<line>"`/`"Include file <file>"`/`"Toggle replace"`/`"Replacement text"`/`"Replace all"`, rail `[title="Explorer"]`/`[title="Search"]`/`[title="Source Control"]`/`[title="Pull Requests"]`, PRs `.view .card` + "Open" Btn, notifications: target by text (`text=All matches are excluded`).
- Story/agent/requirement file formats: YAML frontmatter, snake_case keys (`pr_url`, `feature_branch`, `parent_requirement`, `depends_on`, `acceptance_criteria`, `created_at`, `updated_at`) — see `src/main/hive/parse.ts:80-140`.

---

## File Structure

- Modify: `src/main/index.ts` (3-line userData hook)
- Create: `playwright.config.ts`
- Create: `e2e/fixtures/hive.ts` (fixture factory + mutators + workspace.json seeder)
- Create: `e2e/helpers/app.ts` (launch/teardown + console-error gate)
- Create: `e2e/specs/orchestration.spec.ts`
- Create: `e2e/specs/parity.spec.ts`
- Modify: `package.json` (devDeps `@playwright/test`, `playwright`; script `e2e`), `package-lock.json`
- Modify: `.github/workflows/ci.yml` (e2e job)
- Modify: `.gitignore` (playwright-report/, test-results/)

---

## Task 1: `HIVE_USER_DATA_DIR` hook + Playwright scaffolding

**Files:**
- Modify: `src/main/index.ts` (~line 97)
- Modify: `package.json`, `package-lock.json`, `.gitignore`
- Create: `playwright.config.ts`

- [ ] **Step 1: userData hook**

In `src/main/index.ts`, directly after `const isDev = !!process.env.ELECTRON_RENDERER_URL;` (line 97), insert:

```typescript
// E2E hook: run against a throwaway userData sandbox. Must execute before
// anything reads app.getPath('userData') (stores construct in whenReady).
if (process.env.HIVE_USER_DATA_DIR && isAbsolute(process.env.HIVE_USER_DATA_DIR)) {
  app.setPath('userData', process.env.HIVE_USER_DATA_DIR);
}
```

Add `isAbsolute` to the existing `node:path` import at the top of the file.

- [ ] **Step 2: install Playwright**

```bash
npm install -D @playwright/test playwright
```

(Electron is driven by Playwright's bundled `_electron`; no browser download needed — do NOT run `npx playwright install`.)

- [ ] **Step 3: config + script + gitignore**

Create `playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/specs',
  // One Electron app at a time — instances share OS-level resources.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
```

In `package.json` scripts add: `"e2e": "playwright test"`.
Append to `.gitignore`:

```
playwright-report/
test-results/
```

- [ ] **Step 4: verify + commit**

Run: `npm run typecheck && npx playwright test --list`
Expected: typecheck clean; playwright reports "no tests found" (exit non-zero is fine — confirm the error is *no tests*, not config).

```bash
git add src/main/index.ts package.json package-lock.json playwright.config.ts .gitignore
git commit -m "feat(e2e): HIVE_USER_DATA_DIR sandbox hook + Playwright scaffolding"
```

---

## Task 2: Fixture factory

**Files:**
- Create: `e2e/fixtures/hive.ts`

No standalone test — Task 3's first spec is its integration test. Keep it pure Node (no Playwright imports).

- [ ] **Step 1: implement**

```typescript
/**
 * Fabricates a hermetic project for one e2e test:
 *  - a real git repo with committed files + two prepared working-tree hunks
 *  - a `.hive` tree (stories/agents/requirements + events/chat ndjson)
 *  - a seeded userData dir whose workspace.json points at the project
 * Mutators (appendEvent/appendChat/writeStory/writeQuestion) let tests drive
 * the app's file-watch pipeline mid-run. Pure Node — no Playwright imports.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Fixture {
  /** Project root (= git repo root = hive workspace). */
  root: string;
  /** Throwaway userData dir seeded with workspace.json. */
  userDataDir: string;
  story(id: string, front: Record<string, unknown>, body?: string): void;
  agent(id: string, front: Record<string, unknown>): void;
  requirement(id: string, front: Record<string, unknown>, body?: string): void;
  question(storyId: string, text: string): void;
  appendEvent(e: { actor: string; event: string; detail?: string; level?: string }): void;
  appendChat(m: { who: string; txt: string }): void;
  readStory(id: string): string;
  git(...args: string[]): string;
  dispose(): void;
}

function yaml(front: Record<string, unknown>): string {
  const lines = Object.entries(front).map(([k, v]) => {
    if (Array.isArray(v)) {
      if (v.length === 0) return `${k}: []`;
      return `${k}:\n${v.map((x) => `  - ${String(x)}`).join('\n')}`;
    }
    return `${k}: ${String(v)}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

export function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'hive-e2e-'));
  const root = join(base, 'repo');
  const userDataDir = join(base, 'user-data');
  mkdirSync(root, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  // --- repo with two well-separated hunks ---------------------------------
  git('init', '-q', '-b', 'main');
  const appJs = [
    ...Array.from({ length: 10 }, (_, i) => `function alpha${i + 1}() { return ${i + 1} }`),
    ...Array.from({ length: 5 }, () => '// section break'),
    ...Array.from({ length: 10 }, (_, i) => `function beta${i + 1}() { return ${i + 1} }`),
  ];
  writeFileSync(join(root, 'app.js'), appJs.join('\n') + '\n');
  writeFileSync(join(root, 'notes.txt'), 'foo target one\nkeep foo here\nfoo target three\n');
  writeFileSync(join(root, 'lib.ts'), 'export function gammaOne(): number { return 1 }\nexport function gammaTwo(): number { return gammaOne() }\n');
  git('add', '-A');
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'commit', '-qm', 'base');
  appJs[1] = 'function alpha2() { return 222 } // HUNK-ONE';
  appJs[20] = 'function beta6() { return 666 } // HUNK-TWO';
  writeFileSync(join(root, 'app.js'), appJs.join('\n') + '\n');

  // --- .hive tree ----------------------------------------------------------
  const hive = join(root, '.hive');
  for (const d of ['state/stories', 'state/agents', 'state/requirements', 'state/questions']) {
    mkdirSync(join(hive, d), { recursive: true });
  }
  writeFileSync(join(hive, 'events.ndjson'), '');
  writeFileSync(join(hive, 'chat.ndjson'), '');

  // --- seeded userData -----------------------------------------------------
  const projectId = 'e2e-0000-0000-0000-000000000001';
  const now = Date.now();
  writeFileSync(
    join(userDataDir, 'workspace.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        lastProjectId: projectId,
        recents: [{ id: projectId, name: 'E2E Project', repoCount: 1, lastOpenedAt: now }],
        projects: {
          [projectId]: {
            id: projectId,
            name: 'E2E Project',
            repos: [{ name: 'repo', path: root, isGitRepo: true }],
            createdAt: now,
            lastOpenedAt: now,
            hiveWorkspacePath: root,
            expandedPaths: [],
          },
        },
        layout: {},
        enabledPlugins: [],
        terminals: {},
        window: { width: 1400, height: 950 },
      },
      null,
      2,
    ),
  );

  return {
    root,
    userDataDir,
    story: (id, front, body = '') =>
      writeFileSync(join(hive, 'state/stories', `${id}.md`), yaml(front) + body),
    agent: (id, front) =>
      writeFileSync(join(hive, 'state/agents', `${id}.md`), yaml(front)),
    requirement: (id, front, body = '') =>
      writeFileSync(join(hive, 'state/requirements', `${id}.md`), yaml(front) + body),
    question: (storyId, text) =>
      writeFileSync(join(hive, 'state/questions', `${storyId}.md`), text),
    appendEvent: (e) =>
      appendFileSync(
        join(hive, 'events.ndjson'),
        JSON.stringify({ ts: new Date().toISOString(), detail: '', level: 'info', ...e }) + '\n',
      ),
    appendChat: (m) =>
      appendFileSync(
        join(hive, 'chat.ndjson'),
        JSON.stringify({ ts: new Date().toISOString(), ...m }) + '\n',
      ),
    readStory: (id) => readFileSync(join(hive, 'state/stories', `${id}.md`), 'utf8'),
    git,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}
```

> **Before committing**: open `src/main/state/migrate.ts`, find `defaults()` and the v6 `PersistedState` shape, and make the seeded JSON match it field-for-field (the exact keys above came from a live workspace.json; if `window` or `terminals` differs, copy the real default). A mismatched shape gets archived by `migrate()` and the project won't load.

- [ ] **Step 2: typecheck + commit**

`npx tsc --noEmit e2e/fixtures/hive.ts` will not typecheck standalone (no tsconfig include) — instead run `npx playwright test --list` (playwright transpiles on demand; still "no tests") and `node --input-type=module -e "import('./e2e/fixtures/hive.ts')"` is unnecessary: rely on Task 3's spec. Just commit:

```bash
git add e2e/fixtures/hive.ts
git commit -m "feat(e2e): hive fixture factory (repo + .hive tree + seeded userData)"
```

---

## Task 3: Launch helper + first passing spec

**Files:**
- Create: `e2e/helpers/app.ts`
- Create: `e2e/specs/orchestration.spec.ts` (first test only)

- [ ] **Step 1: launch helper**

```typescript
/**
 * Launches the BUILT app (out/) against a fixture's sandbox userData.
 * Collects uncaught renderer errors; assertCleanConsole() fails the test
 * on anything outside the allowlist.
 */
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { expect } from '@playwright/test';

import type { Fixture } from '../fixtures/hive';

const CONSOLE_ALLOWLIST = [
  /extensions\.json/, // optional per-workspace file; ENOENT log is expected
  /Autofill\./, // devtools protocol noise (dev only, but harmless to allow)
];

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  errors: string[];
  assertCleanConsole(): void;
  close(): Promise<void>;
}

export async function launchApp(fixture: Fixture): Promise<LaunchedApp> {
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RENDERER_URL; // force the built renderer (out/renderer)
  env.HIVE_USER_DATA_DIR = fixture.userDataDir;

  const app = await _electron.launch({ args: ['.'], cwd: process.cwd(), env });
  const window = await app.firstWindow();

  const errors: string[] = [];
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  // App is interactive once the dock banner reflects the hive connection.
  await expect(window.locator('.hive-banner')).toBeVisible({ timeout: 20_000 });

  return {
    app,
    window,
    errors,
    assertCleanConsole: () => {
      const real = errors.filter((e) => !CONSOLE_ALLOWLIST.some((re) => re.test(e)));
      expect(real, `uncaught renderer errors:\n${real.join('\n')}`).toEqual([]);
    },
    close: async () => {
      await app.close();
    },
  };
}
```

- [ ] **Step 2: first spec — boots and connects**

`e2e/specs/orchestration.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

import { makeFixture, type Fixture } from '../fixtures/hive';
import { launchApp, type LaunchedApp } from '../helpers/app';

let fx: Fixture;
let ide: LaunchedApp;

test.beforeEach(async () => {
  fx = makeFixture();
});

test.afterEach(async ({}, testInfo) => {
  if (ide) {
    ide.assertCleanConsole();
    await ide.close();
  }
  if (testInfo.status === testInfo.expectedStatus) fx.dispose();
});

test('boots and connects to the fixture hive workspace', async () => {
  ide = await launchApp(fx);
  const banner = ide.window.locator('.hive-banner--ok');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Connected');
  await expect(banner).toContainText(fx.root);
});
```

- [ ] **Step 3: build + run, iterate until green**

```bash
npm run build
npx playwright test e2e/specs/orchestration.spec.ts
```

Expected: 1 passed. Likely first-run issues to check in order: (a) workspace.json shape archived by migrate (fix the seeder per migrate.ts), (b) banner selector/text (open the trace: `npx playwright show-trace test-results/**/trace.zip`), (c) launch path (confirm `out/main/index.js` exists). The console gate may also catch a real boot error — investigate, don't allowlist blindly.

- [ ] **Step 4: commit**

```bash
git add e2e/helpers/app.ts e2e/specs/orchestration.spec.ts
git commit -m "feat(e2e): electron launch helper + first connect spec"
```

---

## Task 4: Orchestration suite — board, roster, log, chat, PRs

**Files:**
- Modify: `e2e/specs/orchestration.spec.ts`

Append these tests (same `fx`/`ide` harness):

- [ ] **Step 1: board + roster + log streaming**

```typescript
test('board columns reflect story statuses; roster reflects agents', async () => {
  const front = (status: string, title: string) => ({
    title, status, role: 'senior', points: 3, team: 'repo',
    created_at: '2026-06-10T08:00:00Z', updated_at: '2026-06-10T08:00:00Z',
  });
  fx.story('S-PEND', front('pending', 'Pending story'));
  fx.story('S-RUN', front('in-progress', 'Running story'));
  fx.story('S-REV', front('review', 'Review story'));
  fx.story('S-DONE', front('merged', 'Done story'));
  fx.story('S-PROP', { ...front('proposed', 'Proposed story'), parent_requirement: 'REQ-1' });
  fx.agent('senior-1', { role: 'senior', status: 'live', team: 'repo', started_at: '2026-06-10T08:00:00Z', note: 'e2e roster' });
  ide = await launchApp(fx);

  // Stories tab → 4 board cards, proposed excluded from columns.
  await ide.window.click('button.dock-tab:has-text("Stories")');
  await expect(ide.window.locator('.scard')).toHaveCount(4);
  for (const id of ['S-PEND', 'S-RUN', 'S-REV', 'S-DONE']) {
    await expect(ide.window.locator(`.scard .sid:has-text("${id}")`)).toBeVisible();
  }
  await expect(ide.window.locator('.scard .sid:has-text("S-PROP")')).toHaveCount(0);

  // Run tab → roster row.
  await ide.window.click('button.dock-tab:has-text("Run")');
  await expect(ide.window.locator('.agent-row')).toContainText('e2e roster');
});

test('event log streams new lines without reload', async () => {
  ide = await launchApp(fx);
  // manager.log lives in the bottom panel.
  await ide.window.click('text=manager.log');
  fx.appendEvent({ actor: 'manager', event: 'e2e tick', level: 'info' });
  await expect(ide.window.locator('text=e2e tick')).toBeVisible({ timeout: 10_000 });
});
```

(If the bottom panel/manager.log tab needs opening differently, inspect the trace; the tab label text is `manager.log` per BottomPanel.)

- [ ] **Step 2: chat round-trip**

```typescript
test('chat: operator send writes ndjson; manager append renders live', async () => {
  ide = await launchApp(fx);
  await ide.window.click('button.dock-tab:has-text("Chat")');
  const input = ide.window.locator('input[placeholder*="Message the orchestrator"]');
  await input.fill('Hello from e2e');
  await input.press('Enter');
  // Bubble appears only via the real file round-trip (no optimistic echo).
  await expect(ide.window.locator('.chat .msg', { hasText: 'Hello from e2e' })).toBeVisible();
  const ndjson = require('node:fs').readFileSync(require('node:path').join(fx.root, '.hive/chat.ndjson'), 'utf8');
  expect(ndjson).toContain('"who":"you"');
  expect(ndjson).toContain('Hello from e2e');

  fx.appendChat({ who: 'manager', txt: 'Ack from e2e manager' });
  await expect(ide.window.locator('.chat .msg', { hasText: 'Ack from e2e manager' })).toBeVisible();
});
```

(Convert the `require` calls to top-of-file `import { readFileSync } from 'node:fs'` / `import { join } from 'node:path'` — shown inline here for locality.)

- [ ] **Step 3: PRs view + empty state**

```typescript
test('PRs view renders live cards from story prUrl, and an empty state', async () => {
  ide = await launchApp(fx);
  // Empty state first (no prUrl stories yet).
  await ide.window.click('[title="Pull Requests"]');
  await expect(ide.window.locator('text=No pull requests yet')).toBeVisible();

  fx.story('S-PR', {
    title: 'Ship it', status: 'review', role: 'senior', points: 3, team: 'repo',
    feature_branch: 'feat/e2e', pr_url: 'https://github.com/o/r/pull/77',
    created_at: '2026-06-10T08:00:00Z', updated_at: new Date().toISOString(),
  });
  await expect(ide.window.locator('.view .card', { hasText: '#77' })).toBeVisible();
  await expect(ide.window.locator('.view .card')).toContainText('Ship it');
  await expect(ide.window.locator('.view .card')).toContainText('feat/e2e');
  await expect(ide.window.locator('.view .card button', { hasText: 'Open' })).toBeVisible();
});
```

- [ ] **Step 4: run + commit**

```bash
npx playwright test e2e/specs/orchestration.spec.ts
```
Expected: 5 passed. Then:
```bash
git add e2e/specs/orchestration.spec.ts
git commit -m "feat(e2e): orchestration suite — board, roster, log, chat, PRs"
```

---

## Task 5: Needs-input + requirement approval tests

**Files:**
- Modify: `e2e/specs/orchestration.spec.ts`

- [ ] **Step 1: needs-input answer round-trip**

```typescript
test('needs-input: answering flips the story to pending and logs the answer', async () => {
  fx.story('S-Q', {
    title: 'Blocked story', status: 'needs-input', role: 'senior', points: 2, team: 'repo',
    created_at: '2026-06-10T08:00:00Z', updated_at: '2026-06-10T08:00:00Z',
  });
  fx.question('S-Q', 'Which database should I use?');
  ide = await launchApp(fx);

  await ide.window.click('button.dock-tab:has-text("Run")');
  const card = ide.window.locator('.ni-card', { hasText: 'S-Q' });
  await expect(card).toBeVisible();
  await card.locator('textarea[aria-label="Answer for S-Q"]').fill('Use sqlite');
  await card.locator('button', { hasText: 'Send answer' }).click();

  // Observable side effects (src/main/hive/run/question.ts):
  await expect
    .poll(() => fx.readStory('S-Q'))
    .toContain('status: pending');
  const story = fx.readStory('S-Q');
  expect(story).toContain('## Answer');
  expect(story).toContain('Use sqlite');
  // Card leaves the needs-input section once status flips.
  await expect(card).toHaveCount(0);
});
```

> If the question text never renders in `.ni-q` (it may arrive only via the `event:hive:run:question` push from a live run rather than the questions file at boot), that is FINE per spec — assert the card + answer round-trip; drop any assertion on the question text rather than building a stub runner. Check `ipc:hive:questions:list` consumers in App.tsx first (grep `questions`) — if the renderer lists questions at boot, also assert `Which database` is visible.

- [ ] **Step 2: requirement approval gate**

```typescript
test('approving a decomposed requirement flips proposed stories to pending', async () => {
  fx.requirement('REQ-1', {
    title: 'Big feature', status: 'decomposed',
    created_at: '2026-06-10T08:00:00Z', updated_at: '2026-06-10T08:00:00Z',
    decomposed_into: [],
  });
  fx.story('S-P1', {
    title: 'Proposed one', status: 'proposed', role: 'junior', points: 1, team: 'repo',
    parent_requirement: 'REQ-1',
    created_at: '2026-06-10T08:00:00Z', updated_at: '2026-06-10T08:00:00Z',
  });
  ide = await launchApp(fx);

  await ide.window.click('button.dock-tab:has-text("Run")');
  const card = ide.window.locator('.req-card', { hasText: 'REQ-1' });
  await expect(card).toBeVisible();
  await expect(card.locator('.req-pstory', { hasText: 'Proposed one' })).toBeVisible();
  await card.locator('button', { hasText: 'Approve plan' }).click();

  await expect.poll(() => fx.readStory('S-P1')).toContain('status: pending');
  // The story now appears on the board's pending column.
  await ide.window.click('button.dock-tab:has-text("Stories")');
  await expect(ide.window.locator('.scard .sid:has-text("S-P1")')).toBeVisible();
});
```

(Check `parseRequirement` for the exact frontmatter key of `decomposedInto` — the parser reads `decomposed_into`; an empty list is fine since grouping uses the stories' `parent_requirement`.)

- [ ] **Step 3: run + commit**

```bash
npx playwright test e2e/specs/orchestration.spec.ts
```
Expected: 7 passed.
```bash
git add e2e/specs/orchestration.spec.ts
git commit -m "feat(e2e): needs-input answer + requirement approval round-trips"
```

---

## Task 6: Parity suite

**Files:**
- Create: `e2e/specs/parity.spec.ts`

- [ ] **Step 1: write the suite**

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

import { makeFixture, type Fixture } from '../fixtures/hive';
import { launchApp, type LaunchedApp } from '../helpers/app';

let fx: Fixture;
let ide: LaunchedApp;

test.beforeEach(async () => {
  fx = makeFixture();
  ide = await launchApp(fx);
});

test.afterEach(async ({}, testInfo) => {
  ide.assertCleanConsole();
  await ide.close();
  if (testInfo.status === testInfo.expectedStatus) fx.dispose();
});

async function openWorkingTreeDiff(): Promise<void> {
  await ide.window.click('[title="Source Control"]');
  await ide.window.locator('text=app.js').first().click();
  await ide.window.click('[title="Explorer"]'); // diff tab opens in the IDE view
  await expect(ide.window.locator('.hunkbar-row')).toHaveCount(2);
}

test('stage + unstage a single hunk against real git', async () => {
  await openWorkingTreeDiff();
  await ide.window.click('button[aria-label="Stage hunk 1"]');
  await expect(ide.window.locator('.hunkbar-row')).toHaveCount(1);
  expect(fx.git('diff', '--cached')).toContain('HUNK-ONE');
  expect(fx.git('diff', '--cached')).not.toContain('HUNK-TWO');

  // Staged bucket appears; open the index diff and unstage.
  await ide.window.click('[title="Source Control"]');
  await ide.window.locator('text=app.js').first().click(); // staged section sorts first
  await ide.window.click('[title="Explorer"]');
  await ide.window.click('button[aria-label="Unstage hunk 1"]');
  await expect.poll(() => fx.git('diff', '--cached')).toBe('');
});

test('replace-in-files honors per-match opt-out', async () => {
  await ide.window.click('[title="Search"]');
  await ide.window.locator('[aria-label="Search query"]').fill('foo');
  const skip = ide.window.locator(`input[aria-label="Include match ${join(fx.root, 'notes.txt')}:2"]`);
  await expect(skip).toBeVisible();
  await skip.click();
  await ide.window.click('[aria-label="Toggle replace"]');
  await ide.window.locator('[aria-label="Replacement text"]').fill('bar');
  await ide.window.click('[aria-label="Replace all"]');
  await expect
    .poll(() => readFileSync(join(fx.root, 'notes.txt'), 'utf8'))
    .toBe('bar target one\nkeep foo here\nbar target three\n');
});

test('replace-in-files warns when every match is excluded', async () => {
  await ide.window.click('[title="Search"]');
  await ide.window.locator('[aria-label="Search query"]').fill('foo');
  const fileBox = ide.window.locator(`input[aria-label="Include file ${join(fx.root, 'notes.txt')}"]`);
  await expect(fileBox).toBeVisible();
  await fileBox.click();
  await ide.window.click('[aria-label="Toggle replace"]');
  await ide.window.locator('[aria-label="Replacement text"]').fill('bar');
  await ide.window.click('[aria-label="Replace all"]');
  await expect(ide.window.locator('text=All matches are excluded')).toBeVisible();
  expect(readFileSync(join(fx.root, 'notes.txt'), 'utf8')).toContain('foo target one');
});

test('find references on a TS symbol shows the panel', async () => {
  // Open lib.ts via quick-open.
  await ide.window.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await ide.window.keyboard.type('lib.ts');
  await ide.window.keyboard.press('Enter');
  await ide.window.locator('.monaco-editor .view-lines >> text=gammaOne').first().click();
  await ide.window.keyboard.press('Shift+F12');
  await expect(ide.window.locator('text=References')).toBeVisible();
  await expect(ide.window.locator('text=gammaOne').first()).toBeVisible();
});
```

- [ ] **Step 2: run, iterate, commit**

```bash
npx playwright test e2e/specs/parity.spec.ts
```
Expected: 4 passed. Known wrinkles: the SCM staged-vs-changes row click in test 1 may need a section-scoped locator (`.locator('text=Staged Changes').locator('..')` …) — use the trace to pin it; references panel heading text is `References` with a count (ReferencesView).

```bash
git add e2e/specs/parity.spec.ts
git commit -m "feat(e2e): parity suite — hunks, replace opt-out, references"
```

---

## Task 7: CI job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: add the job**

Append to `jobs:`:

```yaml
  e2e:
    name: E2E (Playwright + Electron)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
      - name: Run e2e
        run: xvfb-run -a npx playwright test
      - name: Upload report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: |
            playwright-report/
            test-results/
          retention-days: 7
```

- [ ] **Step 2: sanity + commit**

Validate YAML: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" 2>/dev/null || npx js-yaml .github/workflows/ci.yml >/dev/null` (either is fine; if neither tool exists, eyeball indentation against the existing job).

```bash
git add .github/workflows/ci.yml
git commit -m "ci(e2e): run the Playwright suite under xvfb"
```

---

## Task 8: Stabilization + PR

- [ ] **Step 1: full local verification**

```bash
npm run typecheck && npm test
npm run build
npx playwright test   # run 1
npx playwright test   # run 2
npx playwright test   # run 3
```
Expected: unit suite 774 + e2e 11 passed, three times consecutively. Any flake = fix the wait (never add sleeps; prefer `expect.poll` on the observable).

- [ ] **Step 2: push + PR**

```bash
gh auth switch --user nikrich
git push -u origin HEAD:feat/hive-e2e-suite
gh pr create --repo nikrich/hive-ide --base main --head feat/hive-e2e-suite \
  --title "feat(e2e): Playwright e2e suite — hive orchestration + parity regression" \
  --body "<summarize: sandbox hook, fixture factory, 11 tests, CI job, console-error gate; link the spec doc>"
```

Watch CI (`gh pr checks --watch`) — the e2e job runs for the first time on the PR; iterate if the headless environment surfaces issues (most likely: missing system libs for Electron on ubuntu — if so, add an `apt-get install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64` step before the run).

---

## Self-Review (completed during authoring)

- **Spec coverage:** userData hook (T1), harness+config (T1-T3), fixture factory (T2), console-error gate (T3 helper), orchestration suite incl. connect/board/roster/log/chat/needs-input/approval/PRs/clean-console (T3-T5 — clean console enforced globally in afterEach rather than as a separate test, which is stronger), parity suite (T6), CI + artifacts (T7), 3×-green acceptance (T8). Spec's "assert up to the IPC boundary" fallback is encoded in T5 Step 1's note.
- **Placeholders:** none; the two "inspect the trace" notes are debugging instructions for known-uncertain selectors, each with a concrete primary selector to try first.
- **Type consistency:** `Fixture`/`LaunchedApp` interfaces defined in T2/T3 and consumed identically in T4-T6; `makeFixture`/`launchApp`/`assertCleanConsole`/`appendEvent`/`appendChat`/`question`/`readStory` names consistent throughout.
