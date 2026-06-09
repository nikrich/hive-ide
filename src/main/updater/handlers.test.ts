/**
 * updater/handlers.ts — feat/auto-updater.
 *
 * The module reaches into Electron's `ipcMain` / `app` and electron-updater's
 * `autoUpdater`. We don't want a real Electron process, so the module takes a
 * `deps` seam (same approach as project/handlers.ts). `electron` is mocked so
 * the import resolves; ipc / app / autoUpdater / window are injected per test.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  app: { getVersion: () => '0.0.0' },
}));

import {
  CH_CHECK,
  CH_GET_VERSION,
  CH_QUIT_AND_INSTALL,
  EVT_UPDATER_STATUS,
  registerUpdaterHandlers,
  type AutoUpdaterLike,
  type SenderWindow,
} from './handlers';

type IpcListener = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpc {
  readonly handlers = new Map<string, IpcListener>();
  handle(channel: string, listener: IpcListener): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const l = this.handlers.get(channel);
    if (!l) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(l({}, ...args));
  }
}

type AnyListener = (...a: unknown[]) => void;

function makeFakeAutoUpdater() {
  const listeners = new Map<string, AnyListener>();
  const au: AutoUpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    on(event: string, listener: AnyListener) {
      listeners.set(event, listener);
      return au;
    },
    removeListener(event: string) {
      listeners.delete(event);
      return au;
    },
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    quitAndInstall: vi.fn(),
  } as unknown as AutoUpdaterLike;
  return { au, emit: (e: string, payload?: unknown) => listeners.get(e)?.(payload), listeners };
}

function makeFakeWindow() {
  const sends: Array<{ channel: string; payload: unknown }> = [];
  let destroyed = false;
  const win: SenderWindow = {
    isDestroyed: () => destroyed,
    webContents: { send: (channel, payload) => sends.push({ channel, payload }) },
  };
  return { win, sends, destroy: () => { destroyed = true; } };
}

function setup(opts: { isPackaged: boolean }) {
  const ipc = new FakeIpc();
  const { au, emit, listeners } = makeFakeAutoUpdater();
  const { win, sends, destroy } = makeFakeWindow();
  const teardown = registerUpdaterHandlers({
    ipc: ipc as never,
    app: { getVersion: () => '1.2.3' },
    getMainWindow: () => win,
    isPackaged: opts.isPackaged,
    autoUpdater: au,
  });
  return { ipc, au, emit, listeners, win, sends, destroy, teardown };
}

describe('registerUpdaterHandlers()', () => {
  it('registers the three updater:* channels and teardown removes them', () => {
    const { ipc, teardown, listeners } = setup({ isPackaged: true });
    expect(ipc.handlers.has(CH_CHECK)).toBe(true);
    expect(ipc.handlers.has(CH_QUIT_AND_INSTALL)).toBe(true);
    expect(ipc.handlers.has(CH_GET_VERSION)).toBe(true);
    teardown();
    expect(ipc.handlers.size).toBe(0);
    expect(listeners.size).toBe(0); // autoUpdater listeners detached
  });

  it('configures autoDownload on / autoInstallOnAppQuit off when packaged', () => {
    const { au, teardown } = setup({ isPackaged: true });
    expect(au.autoDownload).toBe(true);
    expect(au.autoInstallOnAppQuit).toBe(false);
    teardown();
  });

  it('maps autoUpdater events to status pushes', () => {
    const { emit, sends, teardown } = setup({ isPackaged: true });
    emit('checking-for-update');
    emit('update-available', { version: '2.0.0' });
    emit('download-progress', { percent: 42.5 });
    emit('update-downloaded', { version: '2.0.0' });
    emit('update-not-available');
    emit('error', new Error('boom'));
    expect(sends.map((s) => s.payload)).toEqual([
      { phase: 'checking' },
      { phase: 'available', version: '2.0.0' },
      { phase: 'downloading', percent: 42.5 },
      { phase: 'downloaded', version: '2.0.0' },
      { phase: 'not-available' },
      { phase: 'error', error: 'boom' },
    ]);
    expect(sends.every((s) => s.channel === EVT_UPDATER_STATUS)).toBe(true);
    teardown();
  });

  it('does not push to a destroyed window', () => {
    const { emit, sends, destroy, teardown } = setup({ isPackaged: true });
    destroy();
    emit('update-available', { version: '2.0.0' });
    expect(sends).toHaveLength(0);
    teardown();
  });

  it('updater:check triggers a real check + pushes checking when packaged', async () => {
    const { ipc, au, sends, teardown } = setup({ isPackaged: true });
    await ipc.invoke(CH_CHECK);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(sends[0].payload).toEqual({ phase: 'checking' });
    teardown();
  });

  it('updater:check reports unsupported and skips autoUpdater in dev', async () => {
    const { ipc, au, sends, teardown } = setup({ isPackaged: false });
    await ipc.invoke(CH_CHECK);
    expect(au.checkForUpdates).not.toHaveBeenCalled();
    expect(sends[0].payload).toEqual({ phase: 'unsupported' });
    teardown();
  });

  it('updater:get-version returns app.getVersion()', async () => {
    const { ipc, teardown } = setup({ isPackaged: true });
    await expect(ipc.invoke(CH_GET_VERSION)).resolves.toBe('1.2.3');
    teardown();
  });

  it('updater:quit-and-install delegates to autoUpdater', async () => {
    const { ipc, au, teardown } = setup({ isPackaged: true });
    await ipc.invoke(CH_QUIT_AND_INSTALL);
    expect(au.quitAndInstall).toHaveBeenCalledTimes(1);
    teardown();
  });
});
