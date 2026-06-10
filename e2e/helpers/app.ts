/**
 * Launches the BUILT app (out/) against a fixture's sandbox userData.
 * Collects uncaught renderer errors; assertCleanConsole() fails the test
 * on anything outside the allowlist.
 */
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { expect } from '@playwright/test';

import type { Fixture } from '../fixtures/hive';

const CONSOLE_ALLOWLIST = [
  // Optional per-workspace file; only the missing-file (ENOENT) log is
  // expected — any other extensions.json error should fail the test.
  /ENOENT.*extensions\.json/,
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
  try {
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
  } catch (e) {
    // Don't leak the Electron process when the banner wait (or anything else
    // post-launch) fails — afterEach never receives a LaunchedApp to close.
    await app.close().catch(() => {});
    throw e;
  }
}
