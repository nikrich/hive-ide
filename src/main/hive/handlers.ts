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
