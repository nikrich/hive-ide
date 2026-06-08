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
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { registerFsHandlers } from './fs/handlers';
import { registerGitHandlers } from './git/handlers';
import { GitRunner } from './git/runner';
import { registerHiveHandlers } from './hive/handlers';
import { registerHiveRunHandlers, registerHiveAuthoringHandlers } from './hive/run/handlers';
import { createRunner } from './hive/run/runner';
import { createWorktree as createWt, hasNewCommit as hasCommit } from './hive/run/worktree';
import { writeRunStart, writeRunFinish } from './hive/run/writer';
import { ensureWorkspace } from './hive/run/workspace';
import { createStory } from './hive/run/story';
import { resolveRepoForStory } from './hive/run/repo';
import { parseStory } from './hive/parse';
import { hiveReader } from './hive/reader';
import { registerPluginHandlers } from './plugins/handlers';
import { discoverPlugins } from './plugins/loader';
import { pluginsDir } from './plugins/storage';
import { registerLspHandlers } from './plugins/lsp/manager';
import { registerProjectHandlers } from './project/handlers';
import { registerSearchHandlers } from './search/handlers';
import { registerDebugHandlers } from './debug/handlers';
import { registerShellHandlers } from './shell/handlers';
import { isHttpUrl } from './shell/validate-url';
import {
  PersistedStateStore,
  registerStateIpc,
  unregisterStateIpc,
} from './state/store';
import { SettingsStore, registerSettingsIpc } from './settings/store';
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
let teardownSettingsHandlers: (() => void) | null = null;
let teardownSearchHandlers: (() => void) | null = null;
let teardownDebugHandlers: (() => void) | null = null;
let teardownProjectHandlers: (() => Promise<void>) | null = null;
let teardownShellHandlers: (() => void) | null = null;
let teardownTerminalHandlers: (() => void) | null = null;
let teardownPluginHandlers: (() => void) | null = null;
let teardownLspHandlers: (() => void) | null = null;
let teardownGitHandlers: (() => void) | null = null;
let teardownHiveHandlers: (() => void) | undefined;
let teardownHiveRunHandlers: (() => void) | undefined;
let teardownHiveAuthoringHandlers: (() => void) | undefined;
let activeHiveRunId: string | null = null;
let hiveRunner: ReturnType<typeof createRunner> | null = null;
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

  // Settings store (E4-01) — owns settings.json, broadcasts live changes to
  // the renderer so theme / editor config apply without a restart.
  const settingsStore = new SettingsStore();
  teardownSettingsHandlers = registerSettingsIpc(
    settingsStore,
    () => mainWindow,
  );
  teardownSearchHandlers = registerSearchHandlers();
  teardownDebugHandlers = registerDebugHandlers({
    getMainWindow: () => mainWindow,
    // Resolve a debug adapter for `type`: prefer a plugin-contributed debugger
    // (E3-12), else fall back to an env-configured adapter (js-debug, E3-14).
    resolveAdapter: async (type) => {
      try {
        const dir = await pluginsDir(app);
        const plugins = await discoverPlugins(dir, app.getVersion());
        for (const p of plugins) {
          if (!p.valid) continue;
          const dbg = p.manifest.contributes?.debuggers?.find((d) => d.type === type);
          if (dbg) {
            const program = join(p.rootPath, dbg.program);
            return dbg.runtime
              ? { command: dbg.runtime, args: [program] }
              : { command: program, args: [] };
          }
        }
      } catch {
        // fall through to env-based resolution
      }
      if ((type === 'node' || type === 'pwa-node') && process.env.HIVE_JS_DEBUG_ADAPTER) {
        return { command: process.execPath, args: [process.env.HIVE_JS_DEBUG_ADAPTER] };
      }
      const explicit = process.env[`HIVE_DEBUG_ADAPTER_${type.toUpperCase()}`];
      return explicit ? { command: explicit, args: [] } : null;
    },
  });
  teardownShellHandlers = registerShellHandlers();
  teardownTerminalHandlers = registerTerminalHandlers();
  teardownPluginHandlers = registerPluginHandlers({
    app,
    hiveVersion: app.getVersion(),
    getMainWindow: () => mainWindow,
  });
  teardownLspHandlers = registerLspHandlers({
    app,
    hiveVersion: app.getVersion(),
    getMainWindow: () => mainWindow,
  });
  teardownGitHandlers = registerGitHandlers();
  teardownHiveHandlers = registerHiveHandlers({ getMainWindow: () => mainWindow });

  const hiveGit = new GitRunner();
  hiveRunner = createRunner();
  const hiveSend = (channel: string, payload: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  const activeWorkspacePath = (): string | null => hiveReader.workspacePath();
  const activeRepos = (): import('../types/workspace').Repo[] => {
    const s = store?.get();
    const proj = s && s.lastProjectId ? s.projects[s.lastProjectId] : null;
    return proj?.repos ?? [];
  };
  teardownHiveRunHandlers = registerHiveRunHandlers({
    getWorkspacePath: activeWorkspacePath,
    getRepoPath: (story) => resolveRepoForStory(story.team, activeRepos()),
    getStory: async (storyId) => {
      const ws = activeWorkspacePath();
      if (!ws) return null;
      try {
        const raw = await readFile(
          join(ws, '.hive', 'state', 'stories', `${storyId}.md`),
          'utf8',
        );
        return parseStory(raw, storyId);
      } catch {
        return null;
      }
    },
    readRoleOverride: async (role) => {
      const ws = activeWorkspacePath();
      if (!ws) return null;
      try {
        return await readFile(join(ws, '.hive', 'skills', `${role}.md`), 'utf8');
      } catch {
        return null;
      }
    },
    createWorktree: (o) => createWt({ git: hiveGit, ...o }),
    hasNewCommit: (wt) => hasCommit(wt),
    writeRunStart: async (o) => {
      activeHiveRunId = o.runId;
      await writeRunStart(o);
    },
    writeRunFinish: async (o) => {
      await writeRunFinish(o);
      if (activeHiveRunId === o.runId) activeHiveRunId = null;
    },
    runner: hiveRunner,
    send: hiveSend,
    appendRunLog: (runId, line) => {
      const ws = activeWorkspacePath();
      if (!ws) return;
      const dir = join(ws, '.hive', 'logs');
      void mkdir(dir, { recursive: true })
        .then(() => appendFile(join(dir, `${runId}.log`), line + '\n', 'utf8'))
        .catch(() => undefined);
    },
    now: () => new Date().toISOString(),
    newRunId: () => `run_${randomUUID().slice(0, 8)}`,
  });

  teardownHiveAuthoringHandlers = registerHiveAuthoringHandlers({
    userDataPath: () => app.getPath('userData'),
    ensureWorkspace,
    setReaderWorkspace: async (workspacePath) => {
      await hiveReader.setWorkspace(workspacePath);
    },
    createStory,
    now: () => new Date().toISOString(),
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

  if (teardownSettingsHandlers !== null) {
    teardownSettingsHandlers();
    teardownSettingsHandlers = null;
  }

  if (teardownSearchHandlers !== null) {
    teardownSearchHandlers();
    teardownSearchHandlers = null;
  }

  if (teardownDebugHandlers !== null) {
    teardownDebugHandlers();
    teardownDebugHandlers = null;
  }

  if (teardownShellHandlers !== null) {
    teardownShellHandlers();
    teardownShellHandlers = null;
  }

  if (teardownPluginHandlers !== null) {
    teardownPluginHandlers();
    teardownPluginHandlers = null;
  }

  // LSP teardown disposes every running language-server child. SIGTERM
  // first; SIGKILL after a 5 s grace inside the wrapper.
  if (teardownLspHandlers !== null) {
    teardownLspHandlers();
    teardownLspHandlers = null;
  }

  // Git handlers are pure IPC registrations (the runner spawns short-lived
  // child processes per call and they exit before we do); just remove
  // them so a hot-reload doesn't double-register.
  if (teardownGitHandlers !== null) {
    teardownGitHandlers();
    teardownGitHandlers = null;
  }

  teardownHiveHandlers?.();

  teardownHiveRunHandlers?.();
  teardownHiveRunHandlers = undefined;
  teardownHiveAuthoringHandlers?.();
  teardownHiveAuthoringHandlers = undefined;
  if (activeHiveRunId && hiveRunner) void hiveRunner.stop(activeHiveRunId);
  hiveRunner = null;

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
