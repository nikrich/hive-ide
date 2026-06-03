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
import { relative } from 'node:path';

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
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

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
 * Path segments we never want to watch — watching them floods IPC and
 * triggers spurious reloads. The predicate runs on a path **relative to the
 * watch root**, so a repo whose own folder is named e.g. `build` is still
 * watched; only a `build` directory *inside* the repo is skipped. Centralised
 * here so the ignore set is tunable in one place.
 */
const IGNORED_WATCH_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.DS_Store',
]);

/** True if a root-relative path contains an ignored segment. */
export function isIgnoredWatchPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => IGNORED_WATCH_SEGMENTS.has(segment));
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
    createWatcher: (rootPath) =>
      adaptChokidarWatcher(
        chokidarWatch(rootPath, {
          ignoreInitial: true,
          persistent: true,
          // chokidar v4's `ignored` must be a predicate (glob strings were
          // dropped in v4). We test it against the path *relative to the
          // root* so the root folder itself is never accidentally ignored.
          ignored: (watchedPath: string) =>
            isIgnoredWatchPath(relative(rootPath, watchedPath)),
          // chokidar's own awaitWriteFinish is *not* used — we do our own
          // 100ms debounce at the IPC boundary so we keep control over the
          // renderer-facing batching semantics.
        }),
      ),
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
// Default chokidar → WatchHandle adapter
// ---------------------------------------------------------------------------

/**
 * Adapt a chokidar `FSWatcher` to our `WatchHandle` shape. Kept private to
 * this module — the rest of the codebase only sees `WatchHandle`, so a
 * future swap to another watcher (e.g. `node:fs.watch` on platforms where
 * chokidar's native fsevents binding is unavailable) wouldn't ripple.
 */
function adaptChokidarWatcher(watcher: FSWatcher): WatchHandle {
  const handle: WatchHandle = {
    onChange(handler) {
      watcher.on('add', (p) => handler('add', p));
      watcher.on('change', (p) => handler('change', p));
      watcher.on('unlink', (p) => handler('unlink', p));
      watcher.on('addDir', (p) => handler('addDir', p));
      watcher.on('unlinkDir', (p) => handler('unlinkDir', p));
      return handle;
    },
    onError(handler) {
      // chokidar types the `error` payload as `unknown` (because not every
      // upstream emitter guarantees an `Error`); coerce to a real Error so
      // our public surface keeps its narrower signature.
      watcher.on('error', (err) => {
        handler(err instanceof Error ? err : new Error(String(err)));
      });
      return handle;
    },
    close: () => watcher.close(),
  };
  return handle;
}
