/**
 * In-app updater IPC + electron-updater wiring (feat/auto-updater).
 *
 * Three `updater:*` request/response channels reached via
 * `window.hive.updater.*`, plus one main → renderer event channel
 * (`updater:status`) carrying UpdaterStatus pushes. Same shape as
 * src/main/project/handlers.ts: a `deps` seam for testability and a
 * `registerUpdaterHandlers()` that returns a teardown closure.
 *
 * Behaviour: autoDownload is ON, autoInstallOnAppQuit is OFF — we never
 * install behind the user's back. On `update-downloaded` we push a
 * `downloaded` status and the renderer prompts for a restart.
 *
 * Known limitation: on macOS, `quitAndInstall` only completes for a *signed*
 * build (CI signing is conditional). Unsigned mac builds download fine but
 * cannot self-install. Windows (NSIS) and Linux (AppImage) update normally.
 */

import { ipcMain as defaultIpcMain, app as defaultApp, type IpcMain, type App } from 'electron';

import type { UpdaterStatus } from '../../preload/api';

export const CH_CHECK = 'updater:check' as const;
export const CH_QUIT_AND_INSTALL = 'updater:quit-and-install' as const;
export const CH_GET_VERSION = 'updater:get-version' as const;
export const EVT_UPDATER_STATUS = 'updater:status' as const;

/** The slice of electron-updater's `autoUpdater` we depend on. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

/** Minimal window shape we push status to (a real BrowserWindow satisfies it). */
export interface SenderWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

export interface UpdaterHandlersDeps {
  ipc?: IpcMain;
  app?: Pick<App, 'getVersion'>;
  /** Resolve the live renderer window — status pushes target it. */
  getMainWindow: () => SenderWindow | null;
  /** Only wire autoUpdater events + allow real checks in packaged builds. */
  isPackaged: boolean;
  /** Injected electron-updater `autoUpdater`. */
  autoUpdater: AutoUpdaterLike;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Register updater IPC + (in packaged builds) autoUpdater event forwarding.
 * Returns a teardown that removes the IPC handlers and detaches the
 * autoUpdater listeners. Call it from `before-quit`.
 */
export function registerUpdaterHandlers(deps: UpdaterHandlersDeps): () => void {
  const ipc = deps.ipc ?? defaultIpcMain;
  const app = deps.app ?? defaultApp;
  const { getMainWindow, isPackaged, autoUpdater } = deps;

  const push = (status: UpdaterStatus): void => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(EVT_UPDATER_STATUS, status);
  };

  const onChecking = () => push({ phase: 'checking' });
  const onAvailable = (info: unknown) =>
    push({ phase: 'available', version: (info as { version?: string })?.version });
  const onNotAvailable = () => push({ phase: 'not-available' });
  const onProgress = (p: unknown) =>
    push({ phase: 'downloading', percent: (p as { percent?: number })?.percent });
  const onDownloaded = (info: unknown) =>
    push({ phase: 'downloaded', version: (info as { version?: string })?.version });
  const onError = (err: unknown) => push({ phase: 'error', error: errMessage(err) });

  if (isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', onChecking);
    autoUpdater.on('update-available', onAvailable);
    autoUpdater.on('update-not-available', onNotAvailable);
    autoUpdater.on('download-progress', onProgress);
    autoUpdater.on('update-downloaded', onDownloaded);
    autoUpdater.on('error', onError);
  }

  ipc.handle(CH_CHECK, async (): Promise<void> => {
    if (!isPackaged) {
      push({ phase: 'unsupported' });
      return;
    }
    push({ phase: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      push({ phase: 'error', error: errMessage(e) });
    }
  });

  ipc.handle(CH_QUIT_AND_INSTALL, async (): Promise<void> => {
    autoUpdater.quitAndInstall();
  });

  ipc.handle(CH_GET_VERSION, async (): Promise<string> => app.getVersion());

  return () => {
    ipc.removeHandler(CH_CHECK);
    ipc.removeHandler(CH_QUIT_AND_INSTALL);
    ipc.removeHandler(CH_GET_VERSION);
    if (isPackaged) {
      autoUpdater.removeListener('checking-for-update', onChecking);
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('download-progress', onProgress);
      autoUpdater.removeListener('update-downloaded', onDownloaded);
      autoUpdater.removeListener('error', onError);
    }
  };
}
