/**
 * terminal/handlers.ts — REQ-004.
 *
 * Mirrors the dependency-injection pattern used by `shell/handlers.test.ts`:
 *
 *   - Fake `ipc` so we can invoke registered listeners directly.
 *   - Fake `spawnPty` so node-pty's native module never loads in vitest
 *     (its prebuild lives outside the test runner's reach).
 *   - Fake `sender` so we can capture the events the handler would push
 *     to a real renderer.
 *
 * The DI seam is the entire point of the test: we're not exercising
 * node-pty, we're verifying the handler's bookkeeping — id allocation,
 * data + exit forwarding, teardown discipline, payload validation.
 */

import { describe, expect, it, vi } from 'vitest';

// Stub Electron so the module imports cleanly under vitest. The handler
// never touches the real `ipcMain` because we inject `ipc` via deps.
vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
  },
}));

import {
  EVT_TERMINAL_DATA,
  EVT_TERMINAL_EXIT,
  registerTerminalHandlers,
  resolveCwd,
  resolveDefaultShell,
  TERMINAL_CHANNELS,
  type PtyHandle,
  type SpawnInput,
  type TerminalSender,
} from './handlers';

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

  invoke(channel: string, sender: TerminalSender, ...args: unknown[]): Promise<unknown> {
    const listener = this.handlers.get(channel);
    if (!listener) throw new Error(`no handler registered for ${channel}`);
    return Promise.resolve(listener({ sender }, ...args));
  }
}

class FakeSender implements TerminalSender {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  private destroyed = false;
  private destroyedListeners: Array<() => void> = [];

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(_event: 'destroyed', listener: () => void): void {
    this.destroyedListeners.push(listener);
  }

  /** Simulate the WebContents being destroyed (window closed). */
  destroy(): void {
    this.destroyed = true;
    const ls = this.destroyedListeners.splice(0);
    for (const l of ls) l();
  }
}

class FakePty implements PtyHandle {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener:
    | ((e: { exitCode: number; signal?: number }) => void)
    | null = null;

  constructor(public readonly input: SpawnInput) {}

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }
  emitExit(exitCode: number, signal?: number): void {
    this.exitListener?.({ exitCode, signal });
  }
}

interface RegisterFakeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  defaultCwd?: () => string;
}

function registerFake(opts: RegisterFakeOptions = {}): {
  ipc: FakeIpc;
  ptys: FakePty[];
  teardown: () => void;
} {
  const ipc = new FakeIpc();
  const ptys: FakePty[] = [];
  const teardown = registerTerminalHandlers({
    ipc,
    platform: opts.platform ?? 'darwin',
    env: opts.env ?? { SHELL: '/bin/zsh', PATH: '/usr/bin' },
    defaultCwd: opts.defaultCwd ?? (() => '/home/test'),
    spawnPty: (input) => {
      const p = new FakePty(input);
      ptys.push(p);
      return p;
    },
  });
  return { ipc, ptys, teardown };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('resolveDefaultShell()', () => {
  it('uses $SHELL on darwin / linux', () => {
    expect(resolveDefaultShell('darwin', { SHELL: '/bin/fish' })).toEqual({
      shell: '/bin/fish',
      args: [],
    });
    expect(resolveDefaultShell('linux', { SHELL: '/bin/bash' })).toEqual({
      shell: '/bin/bash',
      args: [],
    });
  });

  it('falls back to /bin/zsh on darwin / linux when $SHELL is unset', () => {
    expect(resolveDefaultShell('linux', {})).toEqual({
      shell: '/bin/zsh',
      args: [],
    });
  });

  it('uses %COMSPEC% on win32, falling back to powershell.exe', () => {
    expect(resolveDefaultShell('win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })).toEqual(
      { shell: 'C:\\Windows\\System32\\cmd.exe', args: [] },
    );
    expect(resolveDefaultShell('win32', {})).toEqual({
      shell: 'powershell.exe',
      args: [],
    });
  });
});

describe('resolveCwd()', () => {
  it('returns the requested cwd when it is a non-empty string', () => {
    expect(resolveCwd('/Users/x/code', () => '/home')).toBe('/Users/x/code');
  });

  it('falls back to the default for undefined / empty / non-string', () => {
    expect(resolveCwd(undefined, () => '/home')).toBe('/home');
    expect(resolveCwd('', () => '/home')).toBe('/home');
    expect(resolveCwd(42 as unknown, () => '/home')).toBe('/home');
  });
});

// ---------------------------------------------------------------------------
// registerTerminalHandlers()
// ---------------------------------------------------------------------------

describe('registerTerminalHandlers()', () => {
  it('registers all four IPC channels', () => {
    const { ipc, teardown } = registerFake();
    expect(ipc.handlers.has(TERMINAL_CHANNELS.spawn)).toBe(true);
    expect(ipc.handlers.has(TERMINAL_CHANNELS.write)).toBe(true);
    expect(ipc.handlers.has(TERMINAL_CHANNELS.resize)).toBe(true);
    expect(ipc.handlers.has(TERMINAL_CHANNELS.dispose)).toBe(true);
    teardown();
  });

  it('teardown removes every channel and kills tracked ptys', async () => {
    const { ipc, ptys, teardown } = registerFake();
    const sender = new FakeSender();

    await ipc.invoke(TERMINAL_CHANNELS.spawn, sender, { cwd: '/tmp', cols: 80, rows: 24 });

    teardown();

    expect(ipc.handlers.size).toBe(0);
    expect(ptys[0].killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe('terminal:spawn', () => {
  it('forwards a UUID and remembers shell + cwd + dims', async () => {
    const { ipc, ptys, teardown } = registerFake({
      env: { SHELL: '/bin/zsh' },
      defaultCwd: () => '/home/test',
    });
    const sender = new FakeSender();

    const res = (await ipc.invoke(TERMINAL_CHANNELS.spawn, sender, {
      cwd: '/Users/x/proj',
      cols: 100,
      rows: 30,
    })) as { id: string };

    expect(typeof res.id).toBe('string');
    expect(res.id).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(ptys).toHaveLength(1);
    expect(ptys[0].input.shell).toBe('/bin/zsh');
    expect(ptys[0].input.cwd).toBe('/Users/x/proj');
    expect(ptys[0].input.cols).toBe(100);
    expect(ptys[0].input.rows).toBe(30);
    expect(ptys[0].input.env.TERM).toBe('xterm-256color');

    teardown();
  });

  it('falls back to defaultCwd when cwd is undefined', async () => {
    const { ipc, ptys, teardown } = registerFake({
      defaultCwd: () => '/fallback/home',
    });
    const sender = new FakeSender();

    await ipc.invoke(TERMINAL_CHANNELS.spawn, sender, { cols: 80, rows: 24 });

    expect(ptys[0].input.cwd).toBe('/fallback/home');
    teardown();
  });

  it('rejects malformed payloads at the IPC boundary', async () => {
    const { ipc, teardown } = registerFake();
    const sender = new FakeSender();

    await expect(
      ipc.invoke(TERMINAL_CHANNELS.spawn, sender, { cols: 80 }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      ipc.invoke(TERMINAL_CHANNELS.spawn, sender, null),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      ipc.invoke(TERMINAL_CHANNELS.spawn, sender, { cols: 80, rows: 24, cwd: 42 }),
    ).rejects.toBeInstanceOf(TypeError);

    teardown();
  });

  it('forwards data chunks to the sender keyed by id', async () => {
    const { ipc, ptys, teardown } = registerFake();
    const sender = new FakeSender();

    const { id } = (await ipc.invoke(TERMINAL_CHANNELS.spawn, sender, {
      cols: 80,
      rows: 24,
    })) as { id: string };

    ptys[0].emitData('hello ');
    ptys[0].emitData('world');

    expect(sender.sent).toEqual([
      { channel: EVT_TERMINAL_DATA, payload: { id, data: 'hello ' } },
      { channel: EVT_TERMINAL_DATA, payload: { id, data: 'world' } },
    ]);
    teardown();
  });

  it('forwards exit events and stops tracking the pty', async () => {
    const { ipc, ptys, teardown } = registerFake();
    const sender = new FakeSender();

    const { id } = (await ipc.invoke(TERMINAL_CHANNELS.spawn, sender, {
      cols: 80,
      rows: 24,
    })) as { id: string };

    ptys[0].emitExit(0);

    const exitEvents = sender.sent.filter((e) => e.channel === EVT_TERMINAL_EXIT);
    expect(exitEvents).toEqual([
      { channel: EVT_TERMINAL_EXIT, payload: { id, exitCode: 0, signal: null } },
    ]);

    // After exit, further writes / disposes are no-ops (entry already gone).
    await ipc.invoke(TERMINAL_CHANNELS.write, sender, { id, data: 'x' });
    expect(ptys[0].writes).toHaveLength(0);
    teardown();
  });
});

// ---------------------------------------------------------------------------
// write / resize / dispose
// ---------------------------------------------------------------------------

describe('terminal:write', () => {
  it('forwards bytes to the matching pty', async () => {
    const { ipc, ptys, teardown } = registerFake();
    const sender = new FakeSender();

    const { id } = (await ipc.invoke(TERMINAL_CHANNELS.spawn, sender, {
      cols: 80,
      rows: 24,
    })) as { id: string };

    await ipc.invoke(TERMINAL_CHANNELS.write, sender, { id, data: 'ls\n' });
    expect(ptys[0].writes).toEqual(['ls\n']);
    teardown();
  });

  it('silently ignores writes to an unknown id', async () => {
    const { ipc, teardown } = registerFake();
    const sender = new FakeSender();

    await expect(
      ipc.invoke(TERMINAL_CHANNELS.write, sender, { id: 'bogus', data: 'x' }),
    ).resolves.toBeUndefined();

    teardown();
  });
});

describe('terminal:resize', () => {
  it('clamps to >= 1 and forwards the resize', async () => {
    const { ipc, ptys, teardown } = registerFake();
    const sender = new FakeSender();

    const { id } = (await ipc.invoke(TERMINAL_CHANNELS.spawn, sender, {
      cols: 80,
      rows: 24,
    })) as { id: string };

    await ipc.invoke(TERMINAL_CHANNELS.resize, sender, { id, cols: 120, rows: 40 });
    await ipc.invoke(TERMINAL_CHANNELS.resize, sender, { id, cols: 0, rows: -5 });

    expect(ptys[0].resizes).toEqual([
      { cols: 120, rows: 40 },
      { cols: 1, rows: 1 },
    ]);
    teardown();
  });
});

describe('terminal:dispose', () => {
  it('kills the pty, removes it, and emits a final exit event', async () => {
    const { ipc, ptys, teardown } = registerFake();
    const sender = new FakeSender();

    const { id } = (await ipc.invoke(TERMINAL_CHANNELS.spawn, sender, {
      cols: 80,
      rows: 24,
    })) as { id: string };

    await ipc.invoke(TERMINAL_CHANNELS.dispose, sender, { id });

    expect(ptys[0].killed).toBe(true);
    const exits = sender.sent.filter((e) => e.channel === EVT_TERMINAL_EXIT);
    expect(exits).toEqual([
      {
        channel: EVT_TERMINAL_EXIT,
        payload: { id, exitCode: null, signal: null },
      },
    ]);

    // Subsequent writes are no-ops (pty already gone).
    await ipc.invoke(TERMINAL_CHANNELS.write, sender, { id, data: 'x' });
    expect(ptys[0].writes).toHaveLength(0);

    teardown();
  });
});

describe('window destroyed mid-session', () => {
  it('kills tracked ptys when the renderer goes away', async () => {
    const { ipc, ptys, teardown } = registerFake();
    const sender = new FakeSender();

    await ipc.invoke(TERMINAL_CHANNELS.spawn, sender, { cols: 80, rows: 24 });
    sender.destroy();

    expect(ptys[0].killed).toBe(true);
    teardown();
  });
});
