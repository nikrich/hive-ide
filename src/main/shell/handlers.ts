/**
 * Shell IPC handler — REQ-002 / STORY-020.
 *
 * One channel: `shell:open-external` delegates to Electron's
 * `shell.openExternal()` so the renderer can open external URLs in the
 * user's default browser without holding a `shell` reference of its own.
 *
 * The wiring lives in its own module (instead of inline in
 * `src/main/index.ts`) for the same reason STORY-018's project handlers
 * do: a dependency-injection seam lets us unit-test the handler against
 * fake `ipc` + `openExternal` implementations without booting Electron.
 *
 * Security: the renderer is treated as untrusted (same posture as
 * `fs/handlers.ts` — see its header). Without validation a compromised
 * renderer could ask the OS to open arbitrary URI schemes — `file://`
 * to leak local paths, `javascript:` (some launchers honour it),
 * `vscode://` / `slack://` / `mailto:` etc. We allowlist `http(s)`
 * only; other schemes get a hard reject at the IPC boundary.
 */

import {
  ipcMain as defaultIpcMain,
  shell as defaultShell,
  type IpcMain,
} from 'electron';

import { assertHttpUrl } from './validate-url';

/** Channel name — exported so the preload bridge can reuse it. */
export const CH_OPEN_EXTERNAL = 'shell:open-external' as const;

/**
 * Dependencies the handler reaches outside of pure data. Tests supply
 * fakes; production uses the defaults wired in `registerShellHandlers`.
 */
export interface ShellHandlersDeps {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  openExternal: (url: string) => Promise<void>;
}

function defaultDeps(): ShellHandlersDeps {
  return {
    ipc: defaultIpcMain,
    openExternal: (url) => defaultShell.openExternal(url),
  };
}

/**
 * Register the `shell:open-external` IPC handler. Returns a teardown
 * function that removes the registration — call it before `app.quit()`
 * so a development hot-reload doesn't run into a duplicate-channel
 * error on re-register.
 */
export function registerShellHandlers(
  deps: Partial<ShellHandlersDeps> = {},
): () => void {
  const resolved: ShellHandlersDeps = { ...defaultDeps(), ...deps };

  resolved.ipc.handle(CH_OPEN_EXTERNAL, async (_event, url: unknown) => {
    if (typeof url !== 'string') {
      throw new TypeError('shell:open-external requires a string url');
    }
    const safe = assertHttpUrl(url);
    await resolved.openExternal(safe);
  });

  return () => {
    resolved.ipc.removeHandler(CH_OPEN_EXTERNAL);
  };
}
