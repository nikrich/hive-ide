/**
 * handlers.ts — REQ-002 / STORY-018.
 *
 * The handler module reaches into Electron's `ipcMain`, `dialog`, and
 * `BrowserWindow`, plus chokidar's `watch`. We don't want to spin up an
 * Electron process just to test the four IPC handlers, so the module
 * accepts a `deps` seam — these tests inject fakes for everything.
 *
 * Notable patterns:
 *   - A `FakeIpc` records `handle(channel, listener)` calls so we can
 *     invoke the registered handler directly, just like `ipcMain` would.
 *   - `FakeWatchHandle` lets us pump arbitrary chokidar events without
 *     touching the disk or waiting for native fsevents.
 *   - `vi.useFakeTimers()` makes the 100ms debounce window observable
 *     without slowing the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mockFs from 'mock-fs';

// `electron` is a native runtime — stub it so the module is importable in
// the Node-only vitest environment. The real `ipc` / `dialog` is supplied
// per-test via `deps`.
vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
  },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  },
  BrowserWindow: {
    fromWebContents: () => null,
  },
}));

// Same story for chokidar — the default `createWatcher` would otherwise
// pull in fsevents at import time, which we don't want when every test
// substitutes its own watcher factory anyway.
vi.mock('chokidar', () => ({
  watch: () => ({
    on: () => undefined,
    close: () => Promise.resolve(),
  }),
}));

import {
  CH_INSPECT_FOLDER,
  CH_OPEN_DIALOG,
  CH_UNWATCH,
  CH_WATCH,
  EVT_FS_CHANGED,
  EVT_WATCH_ERROR,
  WATCHER_DEBOUNCE_MS,
  isIgnoredWatchPath,
  registerProjectHandlers,
  type ProjectHandlersDeps,
  type WatchHandle,
  type WatcherSender,
} from './handlers';
import type { FsChangeKind } from '../../preload/api';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type IpcListener = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpc {
  readonly handlers = new Map<string, IpcListener>();

  handle(channel: string, listener: IpcListener): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  /** Invoke a registered handler with a fake event sender. */
  invoke(channel: string, sender: WatcherSender, ...args: unknown[]): Promise<unknown> {
    const listener = this.handlers.get(channel);
    if (!listener) throw new Error(`no handler registered for ${channel}`);
    return Promise.resolve(listener({ sender }, ...args));
  }
}

class FakeSender implements WatcherSender {
  readonly sends: Array<{ channel: string; payload: unknown }> = [];
  private destroyed = false;
  private destroyedListeners: Array<() => void> = [];

  send(channel: string, payload: unknown): void {
    this.sends.push({ channel, payload });
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: 'destroyed', listener: () => void): void {
    if (event !== 'destroyed') return;
    this.destroyedListeners.push(listener);
  }

  /** Simulate the WebContents going away (window closed). */
  destroy(): void {
    this.destroyed = true;
    const fns = this.destroyedListeners;
    this.destroyedListeners = [];
    for (const fn of fns) fn();
  }
}

interface FakeWatch {
  rootPath: string;
  handle: WatchHandle;
  /** Drive an FS change event into the handler. */
  emitChange: (kind: FsChangeKind, path: string) => void;
  /** Drive an error event into the handler. */
  emitError: (err: Error) => void;
  /** Was `close()` called? */
  closed: () => boolean;
}

function makeFakeWatcherFactory(): {
  createWatcher: ProjectHandlersDeps['createWatcher'];
  watches: FakeWatch[];
} {
  const watches: FakeWatch[] = [];
  const createWatcher: ProjectHandlersDeps['createWatcher'] = (rootPath) => {
    let changeHandler: ((kind: FsChangeKind, p: string) => void) | null = null;
    let errorHandler: ((err: Error) => void) | null = null;
    let closed = false;

    const handle: WatchHandle = {
      onChange(h) {
        changeHandler = h;
        return handle;
      },
      onError(h) {
        errorHandler = h;
        return handle;
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };

    const entry: FakeWatch = {
      rootPath,
      handle,
      emitChange: (kind, p) => changeHandler?.(kind, p),
      emitError: (err) => errorHandler?.(err),
      closed: () => closed,
    };
    watches.push(entry);
    return handle;
  };
  return { createWatcher, watches };
}

function defaultTestDeps(
  overrides: Partial<ProjectHandlersDeps> = {},
): { deps: Partial<ProjectHandlersDeps>; ipc: FakeIpc; watches: FakeWatch[] } {
  const ipc = new FakeIpc();
  const factory = makeFakeWatcherFactory();

  const deps: Partial<ProjectHandlersDeps> = {
    ipc,
    showOpenDialog: vi
      .fn<ProjectHandlersDeps['showOpenDialog']>()
      .mockResolvedValue({ canceled: true, filePaths: [] }),
    windowFromWebContents: vi
      .fn<ProjectHandlersDeps['windowFromWebContents']>()
      .mockReturnValue(null),
    createWatcher: factory.createWatcher,
    ...overrides,
  };
  return { deps, ipc, watches: factory.watches };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registerProjectHandlers()', () => {
  it('registers all four project:* channels', async () => {
    const { deps, ipc } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);

    expect(ipc.handlers.has(CH_OPEN_DIALOG)).toBe(true);
    expect(ipc.handlers.has(CH_INSPECT_FOLDER)).toBe(true);
    expect(ipc.handlers.has(CH_WATCH)).toBe(true);
    expect(ipc.handlers.has(CH_UNWATCH)).toBe(true);

    await teardown();
    expect(ipc.handlers.size).toBe(0);
  });

  it('teardown closes any still-open watchers', async () => {
    const { deps, ipc, watches } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);
    const sender = new FakeSender();

    await ipc.invoke(CH_WATCH, sender, '/work/proj-a');
    await ipc.invoke(CH_WATCH, sender, '/work/proj-b');
    expect(watches.length).toBe(2);
    expect(watches.every((w) => !w.closed())).toBe(true);

    await teardown();
    expect(watches.every((w) => w.closed())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// project:open-dialog
// ---------------------------------------------------------------------------

describe('project:open-dialog', () => {
  it('returns the selected path when the user confirms', async () => {
    const showOpenDialog = vi
      .fn<ProjectHandlersDeps['showOpenDialog']>()
      .mockResolvedValue({ canceled: false, filePaths: ['/Users/me/code/acme'] });
    const { deps, ipc } = defaultTestDeps({ showOpenDialog });

    const teardown = registerProjectHandlers(deps);
    const result = await ipc.invoke(CH_OPEN_DIALOG, new FakeSender());
    await teardown();

    expect(result).toEqual({ canceled: false, path: '/Users/me/code/acme' });
    expect(showOpenDialog).toHaveBeenCalledWith(null, { properties: ['openDirectory'] });
  });

  it('returns canceled when the dialog is dismissed', async () => {
    const { deps, ipc } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);

    const result = await ipc.invoke(CH_OPEN_DIALOG, new FakeSender());
    await teardown();

    expect(result).toEqual({ canceled: true });
  });

  it('returns canceled when filePaths is empty even if canceled === false', async () => {
    const showOpenDialog = vi
      .fn<ProjectHandlersDeps['showOpenDialog']>()
      .mockResolvedValue({ canceled: false, filePaths: [] });
    const { deps, ipc } = defaultTestDeps({ showOpenDialog });
    const teardown = registerProjectHandlers(deps);

    const result = await ipc.invoke(CH_OPEN_DIALOG, new FakeSender());
    await teardown();

    expect(result).toEqual({ canceled: true });
  });
});

// ---------------------------------------------------------------------------
// project:inspect-folder
// ---------------------------------------------------------------------------

describe('project:inspect-folder', () => {
  afterEach(() => {
    mockFs.restore();
  });

  it('delegates to inspectFolder() and returns { path, name, isGitRepo }', async () => {
    mockFs({
      '/work/some-repo': {
        '.git': { HEAD: 'ref: refs/heads/main' },
      },
    });

    const { deps, ipc } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);

    const folder = (await ipc.invoke(
      CH_INSPECT_FOLDER,
      new FakeSender(),
      '/work/some-repo',
    )) as { path: string; name: string; isGitRepo: boolean };
    await teardown();

    expect(folder).toEqual({
      path: '/work/some-repo',
      name: 'some-repo',
      isGitRepo: true,
    });
  });

  it('reports isGitRepo=false for a non-git folder', async () => {
    mockFs({
      '/work/plain': {
        'notes.md': 'just a folder',
      },
    });

    const { deps, ipc } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);

    const folder = (await ipc.invoke(
      CH_INSPECT_FOLDER,
      new FakeSender(),
      '/work/plain',
    )) as { path: string; name: string; isGitRepo: boolean };
    await teardown();

    expect(folder).toEqual({
      path: '/work/plain',
      name: 'plain',
      isGitRepo: false,
    });
  });

  it('rejects when path is not a string', async () => {
    const { deps, ipc } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);

    await expect(
      ipc.invoke(CH_INSPECT_FOLDER, new FakeSender(), 42),
    ).rejects.toThrow(/string path/);
    await teardown();
  });
});

// ---------------------------------------------------------------------------
// project:watch + event:fs-changed
// ---------------------------------------------------------------------------

describe('project:watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an opaque watcherId and forwards forwarded events as event:fs-changed', async () => {
    const { deps, ipc, watches } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);
    const sender = new FakeSender();

    const watcherId = (await ipc.invoke(CH_WATCH, sender, '/proj')) as string;
    expect(typeof watcherId).toBe('string');
    expect(watcherId.length).toBeGreaterThan(0);
    expect(watches[0].rootPath).toBe('/proj');

    watches[0].emitChange('add', '/proj/new-file.ts');
    expect(sender.sends).toHaveLength(0); // debounce still pending

    vi.advanceTimersByTime(WATCHER_DEBOUNCE_MS);

    expect(sender.sends).toEqual([
      {
        channel: EVT_FS_CHANGED,
        payload: { path: '/proj/new-file.ts', kind: 'add' },
      },
    ]);

    await teardown();
  });

  it('batches and collapses repeated events to the same path within the debounce window', async () => {
    const { deps, ipc, watches } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);
    const sender = new FakeSender();

    await ipc.invoke(CH_WATCH, sender, '/proj');
    const watch = watches[0];

    // Simulate a write that triggers add+change+change in rapid succession.
    watch.emitChange('add', '/proj/file.ts');
    watch.emitChange('change', '/proj/file.ts');
    watch.emitChange('change', '/proj/file.ts');
    // And one event on a different path so we can verify both come through.
    watch.emitChange('addDir', '/proj/new-dir');

    vi.advanceTimersByTime(WATCHER_DEBOUNCE_MS);

    // Same path collapses to the most recent kind; other path comes through.
    expect(sender.sends).toEqual([
      { channel: EVT_FS_CHANGED, payload: { path: '/proj/file.ts', kind: 'change' } },
      { channel: EVT_FS_CHANGED, payload: { path: '/proj/new-dir', kind: 'addDir' } },
    ]);

    await teardown();
  });

  it('forwards all five chokidar event kinds', async () => {
    const { deps, ipc, watches } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);
    const sender = new FakeSender();

    await ipc.invoke(CH_WATCH, sender, '/proj');

    const kinds: FsChangeKind[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'];
    kinds.forEach((kind, i) => {
      watches[0].emitChange(kind, `/proj/p${i}`);
    });

    vi.advanceTimersByTime(WATCHER_DEBOUNCE_MS);

    expect(sender.sends.map((s) => s.payload)).toEqual(
      kinds.map((kind, i) => ({ path: `/proj/p${i}`, kind })),
    );

    await teardown();
  });

  it('forwards chokidar errors as event:watch-error carrying the watcherId', async () => {
    const { deps, ipc, watches } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);
    const sender = new FakeSender();

    const watcherId = (await ipc.invoke(CH_WATCH, sender, '/proj')) as string;
    watches[0].emitError(new Error('EACCES: permission denied'));

    expect(sender.sends).toEqual([
      {
        channel: EVT_WATCH_ERROR,
        payload: { watcherId, error: 'EACCES: permission denied' },
      },
    ]);

    await teardown();
  });

  it('stringifies non-Error throwables in event:watch-error', async () => {
    const { deps, ipc, watches } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);
    const sender = new FakeSender();

    const watcherId = (await ipc.invoke(CH_WATCH, sender, '/proj')) as string;
    // Cast: chokidar's `error` is typed as Error but defensive code in the
    // handler treats anything as fair game.
    (watches[0].emitError as unknown as (err: unknown) => void)('plain-string-failure');

    expect(sender.sends).toEqual([
      {
        channel: EVT_WATCH_ERROR,
        payload: { watcherId, error: 'plain-string-failure' },
      },
    ]);

    await teardown();
  });

  it('does not send to a destroyed WebContents', async () => {
    const { deps, ipc, watches } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);
    const sender = new FakeSender();

    await ipc.invoke(CH_WATCH, sender, '/proj');
    watches[0].emitChange('add', '/proj/a');

    // Window closes before the debounce flushes.
    sender.destroy();
    vi.advanceTimersByTime(WATCHER_DEBOUNCE_MS);

    expect(sender.sends).toHaveLength(0);
    await teardown();
  });

  it('auto-closes the watcher when the WebContents is destroyed', async () => {
    const { deps, ipc, watches } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);
    const sender = new FakeSender();

    await ipc.invoke(CH_WATCH, sender, '/proj');
    expect(watches[0].closed()).toBe(false);

    sender.destroy();
    // closeWatcher runs synchronously up to the chokidar close call.
    await Promise.resolve();
    expect(watches[0].closed()).toBe(true);

    await teardown();
  });

  it('rejects when path is not a string', async () => {
    const { deps, ipc } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);

    await expect(ipc.invoke(CH_WATCH, new FakeSender(), null)).rejects.toThrow(
      /string path/,
    );
    await teardown();
  });
});

// ---------------------------------------------------------------------------
// project:unwatch
// ---------------------------------------------------------------------------

describe('project:unwatch', () => {
  it('closes the named watcher and removes it from the registry', async () => {
    const { deps, ipc, watches } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);
    const sender = new FakeSender();

    const watcherId = (await ipc.invoke(CH_WATCH, sender, '/proj')) as string;
    expect(watches[0].closed()).toBe(false);

    await ipc.invoke(CH_UNWATCH, sender, watcherId);
    expect(watches[0].closed()).toBe(true);

    // A second unwatch is a no-op (idempotent — important for racy teardown).
    await expect(ipc.invoke(CH_UNWATCH, sender, watcherId)).resolves.toBeUndefined();

    await teardown();
  });

  it('no-ops for an unknown watcherId', async () => {
    const { deps, ipc } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);

    await expect(
      ipc.invoke(CH_UNWATCH, new FakeSender(), 'never-existed'),
    ).resolves.toBeUndefined();

    await teardown();
  });

  it('after unwatch, no further events are sent for that watcher', async () => {
    vi.useFakeTimers();
    try {
      const { deps, ipc, watches } = defaultTestDeps();
      const teardown = registerProjectHandlers(deps);
      const sender = new FakeSender();

      const watcherId = (await ipc.invoke(CH_WATCH, sender, '/proj')) as string;
      await ipc.invoke(CH_UNWATCH, sender, watcherId);

      // Even if a stray chokidar event sneaks in after close, the handler is
      // a no-op because the entry is gone from the registry.
      watches[0].emitChange('add', '/proj/late');
      vi.advanceTimersByTime(WATCHER_DEBOUNCE_MS);

      expect(sender.sends).toHaveLength(0);
      await teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when watcherId is not a string', async () => {
    const { deps, ipc } = defaultTestDeps();
    const teardown = registerProjectHandlers(deps);

    await expect(ipc.invoke(CH_UNWATCH, new FakeSender(), 0)).rejects.toThrow(
      /string watcherId/,
    );
    await teardown();
  });
});

// ---------------------------------------------------------------------------
// isIgnoredWatchPath
// ---------------------------------------------------------------------------

describe('isIgnoredWatchPath', () => {
  it('ignores common noise directories anywhere in the relative path', () => {
    expect(isIgnoredWatchPath('node_modules/react/index.js')).toBe(true);
    expect(isIgnoredWatchPath('.git/HEAD')).toBe(true);
    expect(isIgnoredWatchPath('packages/app/dist/bundle.js')).toBe(true);
    expect(isIgnoredWatchPath('build/output.o')).toBe(true);
    expect(isIgnoredWatchPath('out/main/index.js')).toBe(true);
    expect(isIgnoredWatchPath('.next/cache/x')).toBe(true);
    expect(isIgnoredWatchPath('coverage/lcov.info')).toBe(true);
    expect(isIgnoredWatchPath('src/.DS_Store')).toBe(true);
  });

  it('does not ignore ordinary source files', () => {
    expect(isIgnoredWatchPath('src/index.ts')).toBe(false);
    expect(isIgnoredWatchPath('README.md')).toBe(false);
    expect(isIgnoredWatchPath('')).toBe(false); // the watch root itself
  });

  it('handles Windows separators', () => {
    expect(isIgnoredWatchPath('packages\\app\\node_modules\\x')).toBe(true);
    expect(isIgnoredWatchPath('src\\app\\main.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multiple watchers / project switching
// ---------------------------------------------------------------------------

describe('multiple watchers', () => {
  it('returns distinct ids and keeps events isolated per sender', async () => {
    vi.useFakeTimers();
    try {
      const { deps, ipc, watches } = defaultTestDeps();
      const teardown = registerProjectHandlers(deps);
      const senderA = new FakeSender();
      const senderB = new FakeSender();

      const idA = (await ipc.invoke(CH_WATCH, senderA, '/proj-a')) as string;
      const idB = (await ipc.invoke(CH_WATCH, senderB, '/proj-b')) as string;
      expect(idA).not.toBe(idB);

      watches[0].emitChange('add', '/proj-a/x');
      watches[1].emitChange('change', '/proj-b/y');
      vi.advanceTimersByTime(WATCHER_DEBOUNCE_MS);

      expect(senderA.sends).toEqual([
        { channel: EVT_FS_CHANGED, payload: { path: '/proj-a/x', kind: 'add' } },
      ]);
      expect(senderB.sends).toEqual([
        { channel: EVT_FS_CHANGED, payload: { path: '/proj-b/y', kind: 'change' } },
      ]);

      await teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports the "switch project" pattern — unwatch old, watch new', async () => {
    vi.useFakeTimers();
    try {
      const { deps, ipc, watches } = defaultTestDeps();
      const teardown = registerProjectHandlers(deps);
      const sender = new FakeSender();

      const oldId = (await ipc.invoke(CH_WATCH, sender, '/old')) as string;
      await ipc.invoke(CH_UNWATCH, sender, oldId);
      expect(watches[0].closed()).toBe(true);

      const newId = (await ipc.invoke(CH_WATCH, sender, '/new')) as string;
      expect(newId).not.toBe(oldId);
      expect(watches[1].closed()).toBe(false);

      // Old watcher emitting after teardown must not reach the renderer.
      watches[0].emitChange('change', '/old/leaked');
      watches[1].emitChange('change', '/new/legit');
      vi.advanceTimersByTime(WATCHER_DEBOUNCE_MS);

      expect(sender.sends).toEqual([
        { channel: EVT_FS_CHANGED, payload: { path: '/new/legit', kind: 'change' } },
      ]);

      await teardown();
    } finally {
      vi.useRealTimers();
    }
  });
});
