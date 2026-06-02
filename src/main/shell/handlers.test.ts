/**
 * shell/handlers.ts — REQ-002 / STORY-020.
 *
 * Same dependency-injection pattern as STORY-018's project handlers:
 * inject a fake `ipc` so we can invoke the registered listener directly,
 * and a fake `openExternal` so we never touch the real `shell` module.
 */

import { describe, expect, it, vi } from 'vitest';

// `electron` is a native runtime — stub it so the module is importable
// in the Node-only vitest environment. The real `ipc` / `shell` is
// supplied per-test via `deps`.
vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
  },
  shell: {
    openExternal: () => Promise.resolve(),
  },
}));

import { CH_OPEN_EXTERNAL, registerShellHandlers } from './handlers';

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
    if (!listener) {
      throw new Error(`no handler registered for ${channel}`);
    }
    return Promise.resolve(listener({}, ...args));
  }
}

describe('registerShellHandlers()', () => {
  it('registers shell:open-external', () => {
    const ipc = new FakeIpc();
    registerShellHandlers({ ipc, openExternal: () => Promise.resolve() });

    expect(ipc.handlers.has(CH_OPEN_EXTERNAL)).toBe(true);
  });

  it('delegates to openExternal with the normalised URL', async () => {
    const ipc = new FakeIpc();
    const openExternal = vi.fn(() => Promise.resolve());
    registerShellHandlers({ ipc, openExternal });

    // The URL parser appends a trailing slash to an origin-only URL — the
    // handler forwards the normalised form.
    await ipc.invoke(CH_OPEN_EXTERNAL, 'https://example.com');

    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('rejects non-string URLs at the IPC boundary', async () => {
    const ipc = new FakeIpc();
    const openExternal = vi.fn(() => Promise.resolve());
    registerShellHandlers({ ipc, openExternal });

    await expect(ipc.invoke(CH_OPEN_EXTERNAL, 42)).rejects.toBeInstanceOf(TypeError);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'vscode://file/etc/passwd',
    'mailto:foo@example.com',
  ])('rejects non-http(s) URL %s without calling openExternal', async (url) => {
    const ipc = new FakeIpc();
    const openExternal = vi.fn(() => Promise.resolve());
    registerShellHandlers({ ipc, openExternal });

    await expect(ipc.invoke(CH_OPEN_EXTERNAL, url)).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('teardown removes the handler so re-register works', () => {
    const ipc = new FakeIpc();
    const teardown = registerShellHandlers({
      ipc,
      openExternal: () => Promise.resolve(),
    });

    teardown();

    expect(ipc.handlers.has(CH_OPEN_EXTERNAL)).toBe(false);
  });
});
