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
  await ide.window.locator('.scm-row', { hasText: 'app.js' }).first().click();
  await ide.window.click('[title="Explorer"]'); // diff tab opens in the IDE view
  await expect(ide.window.locator('.hunkbar-row')).toHaveCount(2);
}

test('stage + unstage a single hunk against real git', async () => {
  await openWorkingTreeDiff();
  await ide.window.click('button[aria-label="Stage hunk 1"]');
  await expect(ide.window.locator('.hunkbar-row')).toHaveCount(1);
  expect(fx.git('diff', '--cached')).toContain('HUNK-ONE');
  expect(fx.git('diff', '--cached')).not.toContain('HUNK-TWO');

  // Staged bucket appears; open the index diff and unstage. Selector choice:
  // a bare `text=app.js` is ambiguous here (staged row, unstaged row, and the
  // "app.js (Working Tree)" editor tab all match), so scope to the
  // "Staged Changes" section — SourceControlView.tsx renders each bucket as a
  // `.scm-section` whose header carries `.scm-section-title`.
  await ide.window.click('[title="Source Control"]');
  const stagedSection = ide.window.locator('.scm-section', {
    has: ide.window.locator('.scm-section-title', { hasText: 'Staged Changes' }),
  });
  await stagedSection.locator('.scm-row', { hasText: 'app.js' }).click();
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
  // SearchView.tsx:196 posts notify('warning', 'All matches are excluded from
  // replace.') — rendered as a toast in Notifications.tsx (.ntf-msg).
  await expect(ide.window.locator('text=All matches are excluded')).toBeVisible();
  expect(readFileSync(join(fx.root, 'notes.txt'), 'utf8')).toContain('foo target one');
});

test('find references on a TS symbol shows the panel', async () => {
  // Open lib.ts via quick-open (mod+p → workbench.action.quickOpenFiles).
  await ide.window.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await ide.window.keyboard.type('lib.ts');
  // The Files group of the palette is fed by an async filesystem index
  // (CommandPalette.tsx fileIndex); pressing Enter before it loads is a
  // no-op. Click the concrete file row instead of trusting filtered[0].
  await ide.window.locator('.cmd-item', { hasText: 'lib.ts' }).first().click();

  await ide.window.locator('.monaco-editor .view-lines >> text=gammaOne').first().click();
  await ide.window.keyboard.press('Shift+F12');
  // ReferencesView.tsx renders the heading as `.ws-title` containing
  // "References" plus a count span — a bare `text=References` would also be
  // anchored to that node, but scope it explicitly for strictness.
  await expect(
    ide.window.locator('.ws-title', { hasText: 'References' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(ide.window.locator('.srch-preview', { hasText: 'gammaOne' }).first()).toBeVisible();
});
