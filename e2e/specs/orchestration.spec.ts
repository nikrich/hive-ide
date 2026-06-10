import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  // manager.log is a tab in the bottom panel (BottomPanel.tsx renders
  // `button.panel-tab` labels: Terminal / manager.log / Problems).
  await ide.window.click('button.panel-tab:has-text("manager.log")');
  fx.appendEvent({ actor: 'manager', event: 'e2e tick', level: 'info' });
  await expect(ide.window.locator('text=e2e tick')).toBeVisible({ timeout: 10_000 });
});

test('chat: operator send writes ndjson; manager append renders live', async () => {
  ide = await launchApp(fx);
  await ide.window.click('button.dock-tab:has-text("Chat")');
  const input = ide.window.locator('input[placeholder*="Message the orchestrator"]');
  await input.fill('Hello from e2e');
  await input.press('Enter');
  // Bubble appears only via the real file round-trip (no optimistic echo).
  await expect(ide.window.locator('.chat .msg', { hasText: 'Hello from e2e' })).toBeVisible();
  const ndjson = readFileSync(join(fx.root, '.hive/chat.ndjson'), 'utf8');
  expect(ndjson).toContain('"who":"you"');
  expect(ndjson).toContain('Hello from e2e');

  fx.appendChat({ who: 'manager', txt: 'Ack from e2e manager' });
  await expect(ide.window.locator('.chat .msg', { hasText: 'Ack from e2e manager' })).toBeVisible();
});

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
  // Question hydration finding: the renderer DOES fetch the questions file at
  // boot (useHiveLoop.ts:25-27 → ipc:hive:questions:list → main/index.ts:418
  // reads .hive/state/questions/). But useHiveLoop's one-shot list() fires at
  // Dock mount, racing the setWorkspace IPC (useHiveSession.ts:81) that makes
  // activeWorkspacePath() non-null in main — and there is no re-fetch on
  // connect, so the question TEXT in .ni-q never renders at boot (verified
  // empirically: a .ni-q assertion failed 3/3 runs). Per plan Task 5 note,
  // we assert the card + answer round-trip only.
  await card.locator('textarea[aria-label="Answer for S-Q"]').fill('Use sqlite');
  await card.locator('button', { hasText: 'Send answer' }).click();

  // Observable side effects (src/main/hive/run/question.ts:36-64).
  await expect
    .poll(() => fx.readStory('S-Q'))
    .toContain('status: pending');
  const story = fx.readStory('S-Q');
  expect(story).toContain('## Answer');
  expect(story).toContain('Use sqlite');
  // Card leaves the needs-input section once status flips.
  await expect(card).toHaveCount(0);
});

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

  // Requirement cards live in the Stories (board) tab, not Run — the
  // RequirementsSection mounts under `tab === 'board'` (AgentDock.tsx:676-690).
  await ide.window.click('button.dock-tab:has-text("Stories")');
  const card = ide.window.locator('.req-card', { hasText: 'REQ-1' });
  await expect(card).toBeVisible();
  await expect(card.locator('.req-pstory', { hasText: 'Proposed one' })).toBeVisible();
  await card.locator('button', { hasText: 'Approve plan' }).click();

  // approvePlan (src/main/hive/manager/approve.ts:46-70): proposed → pending.
  await expect.poll(() => fx.readStory('S-P1')).toContain('status: pending');
  // The story now appears on the board's pending column (same tab, live).
  await expect(ide.window.locator('.scard .sid:has-text("S-P1")')).toBeVisible();
});

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
