# In-app Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hive IDE checks GitHub Releases, downloads new versions in the background, and prompts the user to restart to install — plus a ⌘K "Check for Updates" command that shows the current version.

**Architecture:** A new `src/main/updater/` module wraps `electron-updater`'s `autoUpdater` behind the repo's standard `deps`-seam + `registerUpdaterHandlers()` teardown pattern (mirrors `src/main/project/handlers.ts`). It exposes three request/response IPC channels and one main→renderer event channel (`updater:status`). The preload bridge gains a `window.hive.updater` namespace. The renderer adds a small Zustand `updaterStore` that subscribes to status pushes and, on `downloaded`, posts an action toast through the existing `notificationsStore` ("Restart to update"). A `Check for Updates` command is registered in `useChromeCommands`.

**Tech Stack:** Electron 33, electron-vite, electron-builder (GitHub publish provider already configured), `electron-updater`, Zustand, Vitest + Testing Library (happy-dom).

**Deviation from spec:** The spec proposed a dedicated `components/UpdateBanner.tsx`. During codebase exploration we found `src/renderer/src/store/notificationsStore.ts` — an app-level toast system with action buttons and a history center. Reusing it for the restart prompt is DRY and matches existing conventions, so this plan uses `notify(...)` instead of a new banner component. Also, the single-file handler+logic shape of `project/handlers.ts` is followed rather than splitting `updater.ts`/`handlers.ts`.

---

### Task 1: Add the `electron-updater` dependency

**Files:**
- Modify: `package.json` (dependencies)

- [ ] **Step 1: Install electron-updater as a runtime dependency**

Run:
```bash
cd /Users/jannik/development/nikrich/hive-ide-updater
npm install electron-updater@^6.3.9 --save
```
Expected: `package.json` gains `"electron-updater"` under `dependencies` (runtime — it executes in the main process), and `package-lock.json` updates.

- [ ] **Step 2: Verify it resolves and the suite still passes**

Run: `npm test`
Expected: PASS — still 645 tests passing (no behaviour added yet).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add electron-updater dependency"
```

---

### Task 2: Updater bridge types in the preload contract

**Files:**
- Modify: `src/preload/api.ts` (add updater types + `HiveUpdaterBridge`, extend `HiveBridge`)

- [ ] **Step 1: Add the updater domain types**

Append to `src/preload/api.ts`, immediately **before** the `export interface HiveBridge {` line:

```ts
// ---------------------------------------------------------------------------
// Updater domain types (feat/auto-updater)
// ---------------------------------------------------------------------------

/** Lifecycle phase of the in-app updater. */
export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'
  | 'unsupported';

/** A status push (main → renderer) describing the updater's current state. */
export interface UpdaterStatus {
  phase: UpdaterPhase;
  /** Target version, when known (available / downloading / downloaded). */
  version?: string;
  /** Download progress 0–100, present during 'downloading'. */
  percent?: number;
  /** Error message, present when phase === 'error'. */
  error?: string;
}

export type UpdaterStatusHandler = (status: UpdaterStatus) => void;

export interface HiveUpdaterBridge {
  /** Trigger a check now. Reports `unsupported` in dev (non-packaged) builds. */
  check(): Promise<void>;
  /** Quit the app and install a downloaded update. */
  quitAndInstall(): Promise<void>;
  /** Current app version (`app.getVersion()`). */
  getVersion(): Promise<string>;
  /** Subscribe to status pushes. Returns an unsubscribe. */
  onStatus(handler: UpdaterStatusHandler): Unsubscribe;
}
```

- [ ] **Step 2: Add the namespace to the `HiveBridge` interface**

In `src/preload/api.ts`, inside `export interface HiveBridge {`, add this line after `plugins: HivePluginsBridge;`:

```ts
  updater: HiveUpdaterBridge;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — `src/preload/index.ts`'s `api` object does not yet implement `updater`, so TS reports `Property 'updater' is missing`. (We implement it in Task 5; this confirms the type is wired.)

- [ ] **Step 4: Commit**

```bash
git add src/preload/api.ts
git commit -m "feat(updater): add updater types to the preload contract"
```

---

### Task 3: Updater main-process module (handlers + autoUpdater wiring)

**Files:**
- Create: `src/main/updater/handlers.ts`
- Test: `src/main/updater/handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/updater/handlers.test.ts`:

```ts
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
    removeAllListeners() {
      listeners.clear();
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/main/updater/handlers.test.ts`
Expected: FAIL — `Cannot find module './handlers'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/updater/handlers.ts`:

```ts
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
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
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

  if (isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => push({ phase: 'checking' }));
    autoUpdater.on('update-available', ((info: { version: string }) =>
      push({ phase: 'available', version: info?.version })) as never);
    autoUpdater.on('update-not-available', () => push({ phase: 'not-available' }));
    autoUpdater.on('download-progress', ((p: { percent: number }) =>
      push({ phase: 'downloading', percent: p?.percent })) as never);
    autoUpdater.on('update-downloaded', ((info: { version: string }) =>
      push({ phase: 'downloaded', version: info?.version })) as never);
    autoUpdater.on('error', ((err: Error) =>
      push({ phase: 'error', error: errMessage(err) })) as never);
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
    autoUpdater.removeAllListeners();
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/main/updater/handlers.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/updater/handlers.ts src/main/updater/handlers.test.ts
git commit -m "feat(updater): main-process updater handlers + autoUpdater wiring"
```

---

### Task 4: Wire the updater into the main entry point

**Files:**
- Modify: `src/main/index.ts` (import, module-scoped handles, register + schedule, before-quit teardown)

- [ ] **Step 1: Add imports**

In `src/main/index.ts`, after the existing `import { registerProjectHandlers } from './project/handlers';` line, add:

```ts
import { registerUpdaterHandlers } from './updater/handlers';
import { autoUpdater } from 'electron-updater';
```

- [ ] **Step 2: Add module-scoped teardown + timer handles**

In `src/main/index.ts`, next to the other `let teardown*Handlers` declarations (near `let teardownPluginHandlers...`), add:

```ts
let teardownUpdaterHandlers: (() => void) | null = null;
let updaterCheckTimer: NodeJS.Timeout | null = null;
```

- [ ] **Step 3: Register handlers + schedule checks inside `app.whenReady()`**

In `src/main/index.ts`, immediately after the `teardownGitHandlers = registerGitHandlers();` line, add:

```ts
  teardownUpdaterHandlers = registerUpdaterHandlers({
    getMainWindow: () => mainWindow,
    isPackaged: app.isPackaged,
    autoUpdater,
  });
  // Background checks only in packaged builds: first ~10s after launch, then
  // every 6 hours. Failures are non-fatal — the next tick retries.
  if (app.isPackaged) {
    const runCheck = (): void => {
      void autoUpdater.checkForUpdates().catch(() => undefined);
    };
    setTimeout(runCheck, 10_000);
    updaterCheckTimer = setInterval(runCheck, 6 * 60 * 60 * 1000);
  }
```

- [ ] **Step 4: Tear down on quit**

In `src/main/index.ts`, inside the `app.on('before-quit', () => {` block, after the `teardownPluginHandlers` teardown block, add:

```ts
  if (updaterCheckTimer !== null) {
    clearInterval(updaterCheckTimer);
    updaterCheckTimer = null;
  }
  if (teardownUpdaterHandlers !== null) {
    teardownUpdaterHandlers();
    teardownUpdaterHandlers = null;
  }
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: still FAIL, but only on the preload `updater` namespace (Task 5). `src/main/index.ts` itself must report no errors. If you see errors mentioning `index.ts`, fix them before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(updater): register updater handlers + schedule background checks"
```

---

### Task 5: Implement the preload bridge

**Files:**
- Modify: `src/preload/index.ts` (channel constants, event constant, `updater` namespace)

- [ ] **Step 1: Add channel constants**

In `src/preload/index.ts`, after the `const PLUGINS = { ... } as const;` block, add:

```ts
const UPDATER = {
  check: 'updater:check',
  quitAndInstall: 'updater:quit-and-install',
  getVersion: 'updater:get-version',
} as const;
```

And after the other `const EVT_* = ...` lines (e.g. near `EVT_PLUGINS_SETUP_PROGRESS`), add:

```ts
const EVT_UPDATER_STATUS = 'updater:status';
```

- [ ] **Step 2: Add the type import**

In `src/preload/index.ts`, add `UpdaterStatus` and `UpdaterStatusHandler` to the existing `import type { ... } from './api';` block.

- [ ] **Step 3: Implement the namespace**

In `src/preload/index.ts`, inside the `const api: HiveBridge = {` object, add this entry after the `plugins: { ... },` block:

```ts
  // Updater bridge (feat/auto-updater) — three flat request/response methods
  // plus a single main → renderer status push channel. The subscription
  // pattern mirrors `settings.onChange` / `onFsChange`.
  updater: {
    check: () => ipcRenderer.invoke(UPDATER.check),
    quitAndInstall: () => ipcRenderer.invoke(UPDATER.quitAndInstall),
    getVersion: () => ipcRenderer.invoke(UPDATER.getVersion),
    onStatus: (handler: UpdaterStatusHandler) => {
      const listener = (_e: IpcRendererEvent, status: UpdaterStatus): void =>
        handler(status);
      ipcRenderer.on(EVT_UPDATER_STATUS, listener);
      return () => ipcRenderer.removeListener(EVT_UPDATER_STATUS, listener);
    },
  },
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS — `HiveBridge` is now fully implemented.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(updater): expose window.hive.updater in the preload bridge"
```

---

### Task 6: Renderer updater store

**Files:**
- Create: `src/renderer/src/store/updaterStore.ts`
- Test: `src/renderer/src/store/updaterStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/store/updaterStore.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdaterStatus, UpdaterStatusHandler } from '../../../preload/api';
import { useUpdaterStore } from './updaterStore';
import { useNotificationsStore } from './notificationsStore';

let statusHandler: UpdaterStatusHandler | null = null;
const check = vi.fn(() => Promise.resolve());
const quitAndInstall = vi.fn(() => Promise.resolve());

beforeEach(() => {
  statusHandler = null;
  check.mockClear();
  quitAndInstall.mockClear();
  useNotificationsStore.setState({ items: [], unread: 0 });
  useUpdaterStore.setState({
    status: { phase: 'idle' },
    version: '',
  });
  (window as unknown as { hive: unknown }).hive = {
    updater: {
      check,
      quitAndInstall,
      getVersion: () => Promise.resolve('3.1.4'),
      onStatus: (h: UpdaterStatusHandler) => {
        statusHandler = h;
        return () => {
          statusHandler = null;
        };
      },
    },
  };
});

afterEach(() => {
  delete (window as unknown as { hive?: unknown }).hive;
});

function emit(status: UpdaterStatus): void {
  statusHandler?.(status);
}

describe('updaterStore', () => {
  it('init() loads the current version and subscribes to status', async () => {
    const unsub = useUpdaterStore.getState().init();
    await Promise.resolve();
    await Promise.resolve();
    expect(useUpdaterStore.getState().version).toBe('3.1.4');
    expect(typeof statusHandler).toBe('function');
    unsub();
    expect(statusHandler).toBeNull();
  });

  it('stores the latest pushed status', () => {
    useUpdaterStore.getState().init();
    emit({ phase: 'downloading', percent: 30 });
    expect(useUpdaterStore.getState().status).toEqual({ phase: 'downloading', percent: 30 });
  });

  it('posts a Restart action toast when an update is downloaded', () => {
    useUpdaterStore.getState().init();
    emit({ phase: 'downloaded', version: '3.2.0' });
    const items = useNotificationsStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].message).toContain('3.2.0');
    expect(items[0].actions?.[0].label).toMatch(/restart/i);
    items[0].actions?.[0].run();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('checkForUpdates() calls the bridge and notifies up-to-date on not-available', () => {
    useUpdaterStore.setState({ version: '3.1.4' });
    useUpdaterStore.getState().init();
    useUpdaterStore.getState().checkForUpdates();
    expect(check).toHaveBeenCalledTimes(1);
    emit({ phase: 'not-available' });
    const msgs = useNotificationsStore.getState().items.map((i) => i.message);
    expect(msgs.some((m) => /up to date/i.test(m))).toBe(true);
  });

  it('a background not-available (no manual check) does NOT notify', () => {
    useUpdaterStore.getState().init();
    emit({ phase: 'not-available' });
    expect(useNotificationsStore.getState().items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/store/updaterStore.test.ts`
Expected: FAIL — `Cannot find module './updaterStore'`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/store/updaterStore.ts`:

```ts
/**
 * Renderer updater store (feat/auto-updater).
 *
 * Subscribes to `window.hive.updater.onStatus` and mirrors the latest status.
 * On `downloaded` it posts an action toast through the notifications store
 * ("Restart to update"). Manual checks (`checkForUpdates`) flag the next
 * terminal status so the operator gets feedback ("up to date" / errors /
 * "updates run in packaged builds only") without background checks nagging.
 */

import { create } from 'zustand';

import type { UpdaterStatus } from '../../../preload/api';
import { notify } from './notificationsStore';

/** Set true by a manual check; consumed by the next terminal status. */
let manualPending = false;

export interface UpdaterState {
  status: UpdaterStatus;
  /** Current app version (loaded by `init`); '' until resolved. */
  version: string;
  /** Subscribe to pushes + load version. Idempotent. Returns an unsubscribe. */
  init: () => () => void;
  /** Manual check — gives the operator explicit feedback. */
  checkForUpdates: () => void;
  /** Quit and install a downloaded update. */
  quitAndInstall: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: { phase: 'idle' },
  version: '',

  init: () => {
    const bridge = window.hive?.updater;
    if (!bridge) return () => undefined;

    void bridge
      .getVersion()
      .then((v) => set({ version: v }))
      .catch(() => undefined);

    return bridge.onStatus((status) => {
      set({ status });

      if (status.phase === 'downloaded') {
        const v = status.version ? ` ${status.version}` : '';
        notify('info', `Hive IDE${v} is ready to install`, [
          { label: 'Restart to update', run: () => void bridge.quitAndInstall() },
        ]);
        manualPending = false;
        return;
      }

      if (!manualPending) return;
      // Manual-check feedback for terminal phases.
      if (status.phase === 'not-available') {
        manualPending = false;
        notify('info', `Hive IDE ${get().version} is up to date`);
      } else if (status.phase === 'unsupported') {
        manualPending = false;
        notify('info', 'Updates run in packaged builds only');
      } else if (status.phase === 'error') {
        manualPending = false;
        notify('error', `Update check failed: ${status.error ?? 'unknown error'}`);
      }
    });
  },

  checkForUpdates: () => {
    manualPending = true;
    void window.hive?.updater?.check();
  },

  quitAndInstall: () => {
    void window.hive?.updater?.quitAndInstall();
  },
}));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/store/updaterStore.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/updaterStore.ts src/renderer/src/store/updaterStore.test.ts
git commit -m "feat(updater): renderer updater store (status + restart toast)"
```

---

### Task 7: Register the "Check for Updates" command + init the store

**Files:**
- Modify: `src/renderer/src/lib/useChromeCommands.ts` (register command, show version in title)
- Modify: `src/renderer/src/App.tsx` (init the updater store once on mount)

- [ ] **Step 1: Import the updater store into the chrome-commands hook**

In `src/renderer/src/lib/useChromeCommands.ts`, add to the imports:

```ts
import { useUpdaterStore } from '../store/updaterStore'
```

- [ ] **Step 2: Read the version and add the command**

In `src/renderer/src/lib/useChromeCommands.ts`, inside `useChromeCommands(...)`, after the existing store-hook reads (e.g. `const register = useCommandStore((s) => s.register)`), add:

```ts
  const updaterVersion = useUpdaterStore((s) => s.version)
```

Then, in the `const defs: Command[] = [ ... ]` array (the one inside the "(Re)register chrome commands" effect), add this entry to the array:

```ts
      {
        id: 'workbench.action.checkForUpdates',
        title: updaterVersion
          ? `Check for Updates — v${updaterVersion}`
          : 'Check for Updates…',
        category: 'Help',
        handler: () => useUpdaterStore.getState().checkForUpdates(),
      },
```

Finally, add `updaterVersion` to that effect's dependency array so the title re-registers once the version resolves (find the `}, [register, ...])` closing the effect and append `updaterVersion`).

- [ ] **Step 3: Init the updater store once in the App shell**

In `src/renderer/src/App.tsx`, add the import near the other store imports:

```ts
import { useUpdaterStore } from './store/updaterStore'
```

Then, next to the existing `useChromeCommands(chromeActions)` call inside the `App` component, add:

```ts
  useEffect(() => {
    const unsub = useUpdaterStore.getState().init()
    return unsub
  }, [])
```

(If `useEffect` is not already imported in `App.tsx`, add it to the `react` import.)

- [ ] **Step 4: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS — typecheck clean; full suite green (645 prior + 13 new = 658).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/useChromeCommands.ts src/renderer/src/App.tsx
git commit -m "feat(updater): add Check for Updates command + init store in App"
```

---

### Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS, no type errors, full suite green.

- [ ] **Step 2: Production build smoke (renderer + main bundle)**

Run: `npm run build`
Expected: `tsc -b --noEmit` clean and `electron-vite build` completes — confirms `electron-updater` bundles into the main process without externalization errors.

- [ ] **Step 3: Manual dev smoke (optional, requires a display)**

Run: `npm run dev`, open the palette (⌘K), run **Check for Updates**.
Expected: an "Updates run in packaged builds only" notification (dev is non-packaged). Confirms the command, store init, IPC round-trip, and notification path all work end to end. Real auto-update download/install can only be verified from a packaged + published build.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/auto-updater
```
(Active GitHub account must be `nikrich`; if push is denied, run `gh auth switch --user nikrich && gh auth setup-git` then retry.)

---

## Self-Review

**Spec coverage:**
- Auto-download + restart prompt → Tasks 3 (autoDownload/`downloaded` push), 6 (restart toast). ✅
- Periodic + on-launch checks → Task 4 (10s + 6h). ✅
- ⌘K "Check for updates" + version → Task 7. ✅
- `window.hive.updater` namespace + `onStatus` subscription → Tasks 2, 5. ✅
- Dev/non-packaged guard (`unsupported`) → Tasks 3, 6. ✅
- macOS-signing limitation documented → Task 3 module header + spec. ✅
- No build-config changes → confirmed; only `electron-updater` added (Task 1). ✅
- Tests for wrapper/handlers + renderer store → Tasks 3, 6. ✅

**Placeholder scan:** none — every code step contains complete, paste-ready code and exact commands.

**Type consistency:** `UpdaterStatus` / `UpdaterPhase` / `UpdaterStatusHandler` defined once in `preload/api.ts` (Task 2) and imported by main (Task 3), preload (Task 5), and renderer (Task 6). Channels `updater:check` / `updater:quit-and-install` / `updater:get-version` / `updater:status` match across `main/updater/handlers.ts` (Task 3) and `preload/index.ts` (Task 5). `registerUpdaterHandlers` signature matches its call site in `index.ts` (Task 4). Store API `init()` / `checkForUpdates()` / `quitAndInstall()` / `version` matches the command + App usage (Task 7) and the test (Task 6).
