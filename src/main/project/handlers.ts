/**
 * Project lifecycle IPC + chokidar filesystem watcher.
 *
 * Exposes four `ipcMain.handle` channels that the renderer reaches via
 * `window.hive.project.*`:
 *
 *   - `project:open-dialog`    → wraps `dialog.showOpenDialog` with the
 *     calling window as parent so the sheet attaches cleanly on macOS.
 *   - `project:inspect-folder` → delegates to the pure `inspectFolder()` —
 *     returns `{ path, name, isGitRepo }` for the picked folder (REQ-003).
 *   - `project:watch`          → starts a chokidar watcher rooted at the
 *     given path, returns a string `watcherId`, and stores the watcher
 *     keyed by it.
 *   - `project:unwatch`        → closes the named watcher and removes it
 *     from the registry. No-op for unknown ids (idempotent teardown).
 *
 * Chokidar add/change/unlink/addDir/unlinkDir events are batched with a
 * 100ms debounce and forwarded as `event:fs-changed` so a `npm install`
 * inside the project root can't flood the renderer with thousands of IPC
 * messages in a single tick. Errors emitted by chokidar are forwarded as
 * `event:watch-error` carrying the originating `watcherId`.
 *
 * One active project = one watcher; switching projects is the caller's
 * responsibility — `unwatch(oldId)` then `watch(newRoot)`. The registry
 * supports multiple concurrent watchers anyway so the renderer can choose.
 *
 * The module is structured for testability: `registerProjectHandlers()`
 * accepts a `deps` object so tests can swap in a fake `ipc`, a fake
 * `showOpenDialog`, and a fake watcher factory. Defaults wire up real
 * Electron + chokidar.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';

import {
  ipcMain as defaultIpcMain,
  dialog as defaultDialog,
  BrowserWindow,
  type IpcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type WebContents,
} from 'electron';

import type { FsChangeEvent, FsChangeKind } from '../../preload/api';
import type { InspectedFolder } from '../../types/workspace';
import { inspectFolder } from './inspectFolder';

// ---------------------------------------------------------------------------
// Channel + tuning constants
// ---------------------------------------------------------------------------

export const CH_OPEN_DIALOG = 'project:open-dialog' as const;
export const CH_INSPECT_FOLDER = 'project:inspect-folder' as const;
export const CH_WATCH = 'project:watch' as const;
export const CH_UNWATCH = 'project:unwatch' as const;

export const EVT_FS_CHANGED = 'event:fs-changed' as const;
export const EVT_WATCH_ERROR = 'event:watch-error' as const;

/** Debounce window for batching chokidar events before sending to the renderer. */
export const WATCHER_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// Watch-path noise filter
// ---------------------------------------------------------------------------

/**
 * Segments matched ANYWHERE in a root-relative path. These are highly
 * distinctive and are the dominant watcher cost (huge file counts / fd
 * pressure), so we suppress them at any depth — including nested copies in
 * a monorepo (`packages/x/node_modules`).
 */
const IGNORED_WATCH_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.next',
  '.DS_Store',
  // Hive agent worktrees — full repo checkouts the orchestrator constantly
  // rewrites. Watching these is the dominant watcher cost in a Hive repo and
  // floods the main process with fs-events (it was the cause of the IDE
  // "hangs on every click" beachball). Never useful to watch.
  '.worktrees',
  '.hive',
  // Build caches / virtualenvs — distinctive dot-names that are always
  // generated output and are safe to ignore at any depth (incl. nested
  // monorepo packages).
  '.gradle',
  '.pytest_cache',
  '__pycache__',
  '.venv',
  '.tox',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.idea',
]);

/**
 * Generic build-output directory names. These double as plausible
 * source-directory or file names (a Go `out` binary, a `src/build/` module),
 * so we only suppress them as the TOP-LEVEL segment of the repo — never
 * deeper — to avoid silently dropping real source changes.
 */
const IGNORED_TOP_LEVEL_SEGMENTS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  'out',
  'coverage',
  'target', // Maven/Gradle/Rust build output (top-level by convention).
  'vendor', // Go/PHP vendored deps.
]);

/** True if a root-relative path should be skipped by the watcher. */
export function isIgnoredWatchPath(relativePath: string): boolean {
  if (relativePath === '') return false;
  const segments = relativePath.split(/[\\/]/);
  return (
    segments.some((segment) => IGNORED_WATCH_SEGMENTS.has(segment)) ||
    IGNORED_TOP_LEVEL_SEGMENTS.has(segments[0])
  );
}

// ---------------------------------------------------------------------------
// Public payload shapes
// ---------------------------------------------------------------------------

/** Resolution of `project:open-dialog`. `path` is omitted when canceled. */
export interface OpenDialogResult {
  canceled: boolean;
  path?: string;
}

/** Payload of an `event:watch-error` message. */
export interface WatchErrorEvent {
  watcherId: string;
  /** `Error.message` if the source was an `Error`, otherwise `String(err)`. */
  error: string;
}

// ---------------------------------------------------------------------------
// Watcher abstraction (so tests don't need a real chokidar FSWatcher)
// ---------------------------------------------------------------------------

/**
 * Narrow watcher surface used by the handler. Implemented for real by an
 * adapter over chokidar's `FSWatcher`; fakes in tests just need to invoke
 * the registered callbacks.
 */
export interface WatchHandle {
  onChange(handler: (kind: FsChangeKind, path: string) => void): WatchHandle;
  onError(handler: (err: Error) => void): WatchHandle;
  close(): Promise<void>;
}

/**
 * Subset of `WebContents` the handler uses to forward events back to the
 * renderer. Lets tests pass a hand-rolled fake without faking all of
 * Electron's `WebContents`.
 */
export interface WatcherSender {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): void;
}

// ---------------------------------------------------------------------------
// Dependency injection seam
// ---------------------------------------------------------------------------

/**
 * Dependencies the handler reaches outside of pure data. Tests supply
 * fakes; production uses the defaults wired in `registerProjectHandlers`.
 */
export interface ProjectHandlersDeps {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  showOpenDialog: (
    parent: BrowserWindow | null,
    options: OpenDialogOptions,
  ) => Promise<OpenDialogReturnValue>;
  windowFromWebContents: (wc: WebContents) => BrowserWindow | null;
  /**
   * Factory invoked with the absolute root path. Returns a `WatchHandle`
   * that emits chokidar's standard add/change/unlink/addDir/unlinkDir
   * events plus `error`.
   */
  createWatcher: (rootPath: string) => WatchHandle;
}

function defaultDeps(): ProjectHandlersDeps {
  return {
    ipc: defaultIpcMain,
    showOpenDialog: (parent, options) =>
      parent
        ? defaultDialog.showOpenDialog(parent, options)
        : defaultDialog.showOpenDialog(options),
    windowFromWebContents: (wc) => BrowserWindow.fromWebContents(wc),
    createWatcher: (rootPath) => createNativeRecursiveWatcher(rootPath),
  };
}

// ---------------------------------------------------------------------------
// Internal registry entry
// ---------------------------------------------------------------------------

interface WatcherEntry {
  handle: WatchHandle;
  sender: WatcherSender;
  /** Set while a flush is pending; `null` between flushes. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Pending events keyed by path. Last `kind` wins — repeated changes to
   * the same path inside the debounce window collapse to one IPC message,
   * which is the behavior the renderer wants (it will re-read the file or
   * re-list the directory anyway).
   */
  pendingEvents: Map<string, FsChangeKind>;
  /** Listener attached to the WebContents `destroyed` event, for cleanup. */
  destroyedListener: () => void;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the four `project:*` IPC handlers. Returns a teardown function
 * that removes the handlers AND closes any still-open watchers — call it
 * before `app.quit()` so chokidar releases its native file descriptors.
 *
 * Each call gets its own watcher registry (closure-scoped), so tests can
 * register independently without leaking state across cases.
 */
export function registerProjectHandlers(
  deps: Partial<ProjectHandlersDeps> = {},
): () => Promise<void> {
  const resolved: ProjectHandlersDeps = { ...defaultDeps(), ...deps };
  const watchers = new Map<string, WatcherEntry>();

  resolved.ipc.handle(CH_OPEN_DIALOG, (event) => handleOpenDialog(event, resolved));
  resolved.ipc.handle(CH_INSPECT_FOLDER, (_event, path: unknown) =>
    handleInspectFolder(path),
  );
  resolved.ipc.handle(CH_WATCH, (event, path: unknown) =>
    handleWatch(event, path, resolved, watchers),
  );
  resolved.ipc.handle(CH_UNWATCH, (_event, watcherId: unknown) =>
    handleUnwatch(watcherId, watchers),
  );

  return async () => {
    resolved.ipc.removeHandler(CH_OPEN_DIALOG);
    resolved.ipc.removeHandler(CH_INSPECT_FOLDER);
    resolved.ipc.removeHandler(CH_WATCH);
    resolved.ipc.removeHandler(CH_UNWATCH);
    await closeAllWatchers(watchers);
  };
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

async function handleOpenDialog(
  event: IpcMainInvokeEvent,
  deps: ProjectHandlersDeps,
): Promise<OpenDialogResult> {
  const parent = deps.windowFromWebContents(event.sender);
  const result = await deps.showOpenDialog(parent, {
    properties: ['openDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
}

async function handleInspectFolder(path: unknown): Promise<InspectedFolder> {
  if (typeof path !== 'string') {
    throw new TypeError('project:inspect-folder requires a string path');
  }
  return inspectFolder(path);
}

async function handleWatch(
  event: IpcMainInvokeEvent,
  path: unknown,
  deps: ProjectHandlersDeps,
  watchers: Map<string, WatcherEntry>,
): Promise<string> {
  if (typeof path !== 'string') {
    throw new TypeError('project:watch requires a string path');
  }

  const watcherId = randomUUID();
  const sender = event.sender as WatcherSender;
  const handle = deps.createWatcher(path);

  const destroyedListener = (): void => {
    // Sender went away (window closed mid-watch). Close the watcher so we
    // don't keep a dangling chokidar instance + native fd around.
    void closeWatcher(watcherId, watchers);
  };

  const entry: WatcherEntry = {
    handle,
    sender,
    debounceTimer: null,
    pendingEvents: new Map(),
    destroyedListener,
  };
  watchers.set(watcherId, entry);

  handle
    .onChange((kind, changedPath) => {
      const live = watchers.get(watcherId);
      if (!live) return;
      live.pendingEvents.set(changedPath, kind);
      scheduleFlush(watcherId, watchers);
    })
    .onError((err) => {
      const live = watchers.get(watcherId);
      if (!live) return;
      if (live.sender.isDestroyed()) return;
      const payload: WatchErrorEvent = {
        watcherId,
        error: err instanceof Error ? err.message : String(err),
      };
      live.sender.send(EVT_WATCH_ERROR, payload);
    });

  sender.once('destroyed', destroyedListener);
  return watcherId;
}

async function handleUnwatch(
  watcherId: unknown,
  watchers: Map<string, WatcherEntry>,
): Promise<void> {
  if (typeof watcherId !== 'string') {
    throw new TypeError('project:unwatch requires a string watcherId');
  }
  // Idempotent: unwatch of an unknown id is a no-op so racy
  // teardown sequences (e.g. close-on-quit + explicit unwatch) don't throw.
  await closeWatcher(watcherId, watchers);
}

// ---------------------------------------------------------------------------
// Debounced flush
// ---------------------------------------------------------------------------

function scheduleFlush(
  watcherId: string,
  watchers: Map<string, WatcherEntry>,
): void {
  const entry = watchers.get(watcherId);
  if (!entry || entry.debounceTimer !== null) return;

  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    const events = entry.pendingEvents;
    entry.pendingEvents = new Map();

    if (entry.sender.isDestroyed()) return;

    for (const [path, kind] of events) {
      const payload: FsChangeEvent = { path, kind };
      entry.sender.send(EVT_FS_CHANGED, payload);
    }
  }, WATCHER_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function closeWatcher(
  watcherId: string,
  watchers: Map<string, WatcherEntry>,
): Promise<void> {
  const entry = watchers.get(watcherId);
  if (!entry) return;
  watchers.delete(watcherId);

  if (entry.debounceTimer !== null) {
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
  }

  try {
    await entry.handle.close();
  } catch {
    // Best-effort: closing an already-closed or errored watcher must not
    // bubble up — the registry entry is already gone.
  }
}

async function closeAllWatchers(
  watchers: Map<string, WatcherEntry>,
): Promise<void> {
  const ids = Array.from(watchers.keys());
  await Promise.all(ids.map((id) => closeWatcher(id, watchers)));
}

// ---------------------------------------------------------------------------
// Default watcher — ONE recursive `fs.watch` per repo
// ---------------------------------------------------------------------------

/**
 * Watch a whole repo with a single recursive `fs.watch`. On macOS/Windows
 * this is backed by ONE OS handle (FSEvents/ReadDirectoryChangesW) for the
 * entire tree.
 *
 * Why not chokidar: chokidar v4 dropped fsevents and watches with a
 * per-directory `fs.watch`. On a repo with thousands of directories (and
 * several repos open at once) that opened thousands of descriptors and
 * exhausted the process FD table — after which EVERY `child_process.spawn`
 * failed with `EBADF`, breaking git/SCM and killing terminal ptys
 * (`[process exited]`). One handle per repo keeps the FD cost flat.
 *
 * Ignored paths (`.git`, `node_modules`, `.worktrees`, build/cache dirs) are
 * filtered in the callback rather than pruned from the watch — the single
 * FSEvents stream covers the tree regardless, so filtering only suppresses
 * noise, it doesn't change the (flat) descriptor cost.
 */
function createNativeRecursiveWatcher(rootPath: string): WatchHandle {
  let changeCb: ((kind: FsChangeKind, path: string) => void) | null = null;
  let errorCb: ((err: Error) => void) | null = null;
  let watcher: FSWatcher | null = null;

  try {
    watcher = fsWatch(
      rootPath,
      { recursive: true, persistent: true },
      (eventType, filename) => {
        if (!filename || !changeCb) return;
        const rel = String(filename);
        if (isIgnoredWatchPath(rel)) return;
        const abs = join(rootPath, rel);
        // `fs.watch` only reports 'change' vs 'rename'. Resolve a rename into
        // add/unlink with a cheap existence check so the editor-reload / SCM
        // pipeline gets the right hint.
        const kind: FsChangeKind =
          eventType === 'change' ? 'change' : existsSync(abs) ? 'add' : 'unlink';
        changeCb(kind, abs);
      },
    );
    watcher.on('error', (err) =>
      errorCb?.(err instanceof Error ? err : new Error(String(err))),
    );
  } catch (err) {
    // Surface async so the caller can register its `onError` first.
    queueMicrotask(() =>
      errorCb?.(err instanceof Error ? err : new Error(String(err))),
    );
  }

  const handle: WatchHandle = {
    onChange(handler) {
      changeCb = handler;
      return handle;
    },
    onError(handler) {
      errorCb = handler;
      return handle;
    },
    close: async () => {
      try {
        watcher?.close();
      } finally {
        watcher = null;
      }
    },
  };
  return handle;
}
