/**
 * LSP IPC manager tests — REQ-007.
 *
 * Same DI pattern as `terminal/handlers.test.ts`: fake `ipc`, fake
 * `spawnServer`, fake `loadPlugin`/`runSetup`. The point is to verify
 * the per-(plugin, language) registry — start returns the same session
 * id for a second call, stop disposes, exit cleans up — without spawning
 * a real child process.
 */

import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

// Stub Electron so the module loads without a real ipcMain.
vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));

import {
  EVT_LSP_DATA,
  EVT_LSP_EXIT,
  LSP_CHANNELS,
  registerLspHandlers,
} from './manager';
import type { LspServerProcess } from './process';
import type { LoadedPlugin } from '../../../types/workspace';

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
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const listener = this.handlers.get(channel);
    if (!listener) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(listener({}, ...args));
  }
}

interface FakeWebContents {
  send(channel: string, payload: unknown): void;
  sent: Array<{ channel: string; payload: unknown }>;
  isDestroyed(): boolean;
}

interface FakeWindow {
  webContents: FakeWebContents;
  isDestroyed(): boolean;
}

function makeWindow(): FakeWindow {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    isDestroyed: () => false,
    webContents: {
      sent,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

class FakeLspProcess extends EventEmitter {
  readonly stdinSink: Buffer[] = [];
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  disposed = false;
  exited = false;
  #exitListeners: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        this.stdinSink.push(Buffer.from(chunk));
        cb();
      },
    });
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  onExit(
    listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): () => void {
    this.#exitListeners.push(listener);
    return () => {
      const idx = this.#exitListeners.indexOf(listener);
      if (idx >= 0) this.#exitListeners.splice(idx, 1);
    };
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Simulate the process emitting stdout bytes. */
  emitStdout(data: string): void {
    this.stdout.push(Buffer.from(data, 'utf8'));
  }

  /** Simulate the process exiting on its own. */
  fakeExit(code: number | null = 0): void {
    this.exited = true;
    for (const listener of this.#exitListeners) {
      listener({ code, signal: null });
    }
  }
}

const PLUGIN: LoadedPlugin = {
  rootPath: '/var/hive/plugins/pub-hello',
  valid: true,
  manifest: {
    id: 'pub/hello',
    name: 'Hello',
    version: '0.1.0',
    contributes: {
      languageServers: [
        {
          language: 'java',
          command: 'java',
          args: ['-jar', 'launcher.jar'],
          initializationOptions: { foo: 'bar' },
        },
      ],
    },
  },
};

// Minimal Electron `App` for `pluginDirFor` — we don't need a real one
// because we override the `loadPlugin` dep so storage lookups don't fire.
const FAKE_APP = {
  getPath: () => '/var/hive',
  getVersion: () => '0.1.0',
} as unknown as Parameters<typeof registerLspHandlers>[0]['app'];

function setup() {
  const ipc = new FakeIpc();
  const win = makeWindow();
  const spawned: FakeLspProcess[] = [];
  const teardown = registerLspHandlers(
    {
      app: FAKE_APP,
      hiveVersion: '0.1.0',
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
    },
    {
      ipc,
      spawnServer: () => {
        const proc = new FakeLspProcess();
        spawned.push(proc);
        return proc as unknown as LspServerProcess;
      },
      loadPlugin: async () => PLUGIN,
      runSetup: async () => undefined,
    },
  );
  return { ipc, win, spawned, teardown };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerLspHandlers — start', () => {
  it('spawns the server for a (plugin, language) pair and returns a sessionId', async () => {
    const { ipc, spawned, teardown } = setup();
    const result = (await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    })) as { sessionId: string; initializationOptions: unknown };
    expect(result.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.initializationOptions).toEqual({ foo: 'bar' });
    expect(spawned).toHaveLength(1);
    teardown();
  });

  it('returns the existing sessionId on a second call for the same pair', async () => {
    const { ipc, spawned, teardown } = setup();
    const first = (await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    })) as { sessionId: string };
    const second = (await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    })) as { sessionId: string };
    expect(second.sessionId).toBe(first.sessionId);
    expect(spawned).toHaveLength(1);
    teardown();
  });

  it('rejects a request for a language the plugin does not contribute', async () => {
    const { ipc, teardown } = setup();
    await expect(
      ipc.invoke(LSP_CHANNELS.start, {
        pluginId: 'pub/hello',
        language: 'cobol',
      }),
    ).rejects.toThrow(/does not contribute a server/);
    teardown();
  });
});

describe('registerLspHandlers — write / stop', () => {
  it('writes base64-decoded bytes to the server stdin', async () => {
    const { ipc, spawned, teardown } = setup();
    const { sessionId } = (await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    })) as { sessionId: string };
    const data = Buffer.from('hello-lsp', 'utf8').toString('base64');
    await ipc.invoke(LSP_CHANNELS.write, { sessionId, data });
    const written = Buffer.concat(spawned[0].stdinSink).toString('utf8');
    expect(written).toBe('hello-lsp');
    teardown();
  });

  it('disposes the process on stop and removes the session', async () => {
    const { ipc, spawned, teardown } = setup();
    const { sessionId } = (await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    })) as { sessionId: string };
    await ipc.invoke(LSP_CHANNELS.stop, { sessionId });
    expect(spawned[0].disposed).toBe(true);
    // A subsequent start spawns a fresh process — the key was cleared.
    await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    });
    expect(spawned).toHaveLength(2);
    teardown();
  });

  it('write on an unknown sessionId is a no-op', async () => {
    const { ipc, teardown } = setup();
    await expect(
      ipc.invoke(LSP_CHANNELS.write, { sessionId: 'nope', data: '' }),
    ).resolves.toBeUndefined();
    teardown();
  });
});

describe('registerLspHandlers — events', () => {
  it('forwards stdout chunks over event:lsp:data, base64-encoded', async () => {
    const { ipc, spawned, win, teardown } = setup();
    const { sessionId } = (await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    })) as { sessionId: string };
    spawned[0].emitStdout('payload-bytes');
    // Allow the stream's data event to flush.
    await new Promise((r) => setImmediate(r));
    const dataEvent = win.webContents.sent.find((e) => e.channel === EVT_LSP_DATA);
    expect(dataEvent).toBeDefined();
    const payload = dataEvent!.payload as { sessionId: string; data: string };
    expect(payload.sessionId).toBe(sessionId);
    expect(Buffer.from(payload.data, 'base64').toString('utf8')).toBe('payload-bytes');
    teardown();
  });

  it('cleans up the registry when the server exits on its own', async () => {
    const { ipc, spawned, win, teardown } = setup();
    await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    });
    spawned[0].fakeExit(0);
    await new Promise((r) => setImmediate(r));
    // A new start spawns a new process — the registry shed the dead one.
    await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    });
    expect(spawned).toHaveLength(2);
    // Exit event was forwarded.
    const exit = win.webContents.sent.find((e) => e.channel === EVT_LSP_EXIT);
    expect(exit).toBeDefined();
    teardown();
  });
});

describe('registerLspHandlers — teardown', () => {
  it('disposes every still-tracked server', async () => {
    const { ipc, spawned, teardown } = setup();
    await ipc.invoke(LSP_CHANNELS.start, {
      pluginId: 'pub/hello',
      language: 'java',
    });
    teardown();
    expect(spawned[0].disposed).toBe(true);
  });

  it('removes the IPC registrations', async () => {
    const { ipc, teardown } = setup();
    teardown();
    expect(ipc.handlers.size).toBe(0);
  });
});

describe('registerLspHandlers — run-setup', () => {
  it('invokes runSetup with the matched plugin record', async () => {
    const ipc = new FakeIpc();
    const win = makeWindow();
    const runSetup = vi.fn(async () => undefined);
    const teardown = registerLspHandlers(
      {
        app: FAKE_APP,
        hiveVersion: '0.1.0',
        getMainWindow: () => win as unknown as Electron.BrowserWindow,
      },
      {
        ipc,
        spawnServer: () => new FakeLspProcess() as unknown as LspServerProcess,
        loadPlugin: async () => PLUGIN,
        runSetup,
      },
    );
    await ipc.invoke(LSP_CHANNELS.runSetup, { pluginId: 'pub/hello' });
    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(runSetup.mock.calls[0][0]).toBe(PLUGIN);
    teardown();
  });
});
