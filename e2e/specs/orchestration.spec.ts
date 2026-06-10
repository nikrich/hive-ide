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
