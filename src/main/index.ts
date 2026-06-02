/**
 * Main-process bootstrap — REQ-002 / STORY-020.
 *
 * Wires the four slices the renderer reaches over IPC into one app:
 *
 *   - `fs:*`               — STORY-017 (filesystem trust boundary)
 *   - `project:*`          — STORY-018 (project lifecycle + chokidar watcher)
 *   - `state:*`            — STORY-019 (electron-store persistence)
 *   - `shell:open-external` — this story
 *
 * Plus two cross-cutting concerns this story owns:
 *
 *   - Restore the window's last-known bounds from `PersistedState.window`
 *     when we create the BrowserWindow, and push new bounds back into the
 *     store as the user drags / resizes (debounced inside the store).
 *   - On `before-quit`, flush the persisted-state store SYNCHRONOUSLY and
 *     tear down the project watcher so chokidar releases its native file
 *     descriptors.
 *
 * Small file, load-bearing: if any registration is missing the renderer's
 * `ipcRenderer.invoke()` will hang. There's no failsafe further down.
 */

import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerFsHandlers } from './fs/handlers';
import { registerPluginHandlers } from './plugins/handlers';
import { registerProjectHandlers } from './project/handlers';
import { registerShellHandlers } from './shell/handlers';
import { isHttpUrl } from './shell/validate-url';
import {
  PersistedStateStore,
  registerStateIpc,
  unregisterStateIpc,
} from './state/store';
import { registerTerminalHandlers } from './terminal/handlers';
import {
  attachBoundsPersistence,
  boundsFromState,
  type BoundsWindow,
} from './window/bounds';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = !!process.env.ELECTRON_RENDERER_URL;

// Module-scoped handles so `before-quit` can reach the same instances we
// created during `whenReady`. They start null and are set exactly once.
let store: PersistedStateStore | null = null;
let teardownProjectHandlers: (() => Promise<void>) | null = null;
let teardownShellHandlers: (() => void) | null = null;
let teardownTerminalHandlers: (() => void) | null = null;
let teardownPluginHandlers: (() => void) | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * Wrap a real `BrowserWindow` in the narrow `BoundsWindow` shape that
 * `attachBoundsPersistence` consumes. Avoids importing the Electron type
 * into the helper module (which is unit-tested without Electron).
 */
function asBoundsWindow(win: BrowserWindow): BoundsWindow {
  return {
    isDestroyed: () => win.isDestroyed(),
    getBounds: () => win.getBounds(),
    on: (event, listener) => {
      // Branch per event so each `win.on(...)` lands on the correct
      // Electron overload — the union arg confuses TS's overload picker.
      if (event === 'resize') win.on('resize', listener);
      else win.on('move', listener);
    },
    removeListener: (event, listener) => {
      if (event === 'resize') win.removeListener('resize', listener);
      else win.removeListener('move', listener);
    },
  };
}

function createWindow(persistedStore: PersistedStateStore): void {
  const initial = boundsFromState(persistedStore.get());

  const win = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    x: initial.x,
    y: initial.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0B0F1A',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  // The store's own 250 ms debounce coalesces the rapid stream of events
  // from a single drag/resize op into one disk write.
  attachBoundsPersistence(
    asBoundsWindow(win),
    () => persistedStore.get(),
    (next) => persistedStore.save(next),
  );

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.on('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'right' });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Mirrors the `shell:open-external` IPC allowlist: an in-page
    // `window.open(...)` from a compromised renderer must not be able to
    // launch arbitrary URI schemes (`file:`, `javascript:`, app
    // protocols). Non-http(s) URLs are silently denied.
    if (isHttpUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // electron-vite emits the renderer to out/renderer/ with index.html at its root.
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // State store first: the window-bounds wiring inside `createWindow`
  // needs it, and `registerStateIpc` binds the renderer to this instance.
  const persistedStore = new PersistedStateStore();
  store = persistedStore;

  registerFsHandlers();
  teardownProjectHandlers = registerProjectHandlers();
  registerStateIpc(persistedStore);
  teardownShellHandlers = registerShellHandlers();
  teardownTerminalHandlers = registerTerminalHandlers();
  teardownPluginHandlers = registerPluginHandlers({
    app,
    hiveVersion: app.getVersion(),
    getMainWindow: () => mainWindow,
  });

  createWindow(persistedStore);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(persistedStore);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // SYNCHRONOUS work first — once the process unwinds we lose the ability
  // to write to disk. The store's `flush()` is sync (electron-store sets
  // are sync) and persists any pending debounced save.
  const persistedStore = store;
  store = null;
  if (persistedStore !== null) {
    persistedStore.flush();
    unregisterStateIpc();
  }

  if (teardownShellHandlers !== null) {
    teardownShellHandlers();
    teardownShellHandlers = null;
  }

  if (teardownPluginHandlers !== null) {
    teardownPluginHandlers();
    teardownPluginHandlers = null;
  }

  // Terminal teardown kills every live pty so the OS reclaims the slave
  // file descriptors. Synchronous — see `registerTerminalHandlers`.
  if (teardownTerminalHandlers !== null) {
    teardownTerminalHandlers();
    teardownTerminalHandlers = null;
  }

  // Project watchers (chokidar) close asynchronously. Fire-and-forget;
  // Electron gives a tick of grace before terminating which is enough on
  // macOS/Linux for the close promises to drain. STORY-018's handler
  // teardown also removes its IPC registrations.
  const projectTeardown = teardownProjectHandlers;
  teardownProjectHandlers = null;
  if (projectTeardown !== null) void projectTeardown();
});
