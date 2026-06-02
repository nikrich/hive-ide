/**
 * Terminal IPC handlers — REQ-004.
 *
 * Wires a pool of `node-pty` pseudoterminals into four request/response
 * channels (`terminal:spawn` / `terminal:write` / `terminal:resize` /
 * `terminal:dispose`) plus two main → renderer event channels
 * (`event:terminal:data` / `event:terminal:exit`).
 *
 * Pattern mirrors `src/main/shell/handlers.ts`:
 *
 *   - `registerTerminalHandlers(deps?)` returns a synchronous teardown
 *     closure. Calling it removes every `ipcMain.handle` registration AND
 *     kills any still-live ptys so the OS reclaims the slave fds.
 *   - All non-pure surface lives behind a `TerminalHandlersDeps` seam so
 *     unit tests inject fake `ipc` + a fake `spawn` without dragging the
 *     real node-pty native module into vitest.
 *
 * One pty per `id` (UUID v4). The id is generated main-side and returned
 * from `terminal:spawn` so the renderer never has to invent ids of its
 * own. Every spawn is tracked in a closure-scoped `Map<id, Tracked>` —
 * `dispose` + `before-quit` walk the map to shut things down cleanly.
 *
 * Renderer-bound data is forwarded with the `id` embedded in the payload
 * (the renderer's `onData(id, …)` bridge filters on it). That keeps the
 * channel namespace flat — we don't dynamically allocate one channel per
 * pty, which would balloon the `ipcRenderer` listener list and force the
 * renderer to remember to unsubscribe by exact channel name.
 *
 * Default shell: `process.env.SHELL ?? '/bin/zsh'` on darwin / linux,
 * `process.env.COMSPEC ?? 'powershell.exe'` on Windows. We pass the
 * user's `process.env` so the spawned shell inherits PATH, HOME, TERM,
 * etc. without our help. `TERM` is forced to `xterm-256color` because
 * xterm.js advertises 256-colour support and many CLIs (vim, htop, less)
 * gate their colour palette on `$TERM`.
 *
 * Spawn safety: the renderer-supplied `cwd` is best-effort. If it
 * doesn't exist or isn't a directory, node-pty raises ENOENT during
 * spawn — we let that bubble back through the IPC promise so the
 * renderer can show a sensible error. The renderer also falls back to
 * `os.homedir()` here when `cwd` is undefined, so picking "no project"
 * still produces a working shell.
 */

import { randomUUID } from 'node:crypto';
import * as os from 'node:os';

import {
  ipcMain as defaultIpcMain,
  type IpcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const TERMINAL_CHANNELS = {
  spawn: 'terminal:spawn',
  write: 'terminal:write',
  resize: 'terminal:resize',
  dispose: 'terminal:dispose',
} as const;

export const EVT_TERMINAL_DATA = 'event:terminal:data' as const;
export const EVT_TERMINAL_EXIT = 'event:terminal:exit' as const;

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

export interface SpawnRequest {
  /** Absolute path. Falls back to `os.homedir()` when undefined. */
  cwd?: string;
  cols: number;
  rows: number;
}

export interface SpawnResponse {
  id: string;
}

export interface WriteRequest {
  id: string;
  data: string;
}

export interface ResizeRequest {
  id: string;
  cols: number;
  rows: number;
}

export interface DisposeRequest {
  id: string;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number | null;
  signal: number | null;
}

// ---------------------------------------------------------------------------
// Pty abstraction
// ---------------------------------------------------------------------------

/**
 * Narrow surface of the pty object we depend on. The real node-pty `IPty`
 * matches this shape; the test fake implements just these methods.
 * Keeping the abstraction narrow means a future swap (e.g. to
 * `child_process.spawn` for environments without a real pty) wouldn't
 * ripple across the rest of the module.
 */
export interface PtyHandle {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Inputs to the pty factory — the resolved shell + cwd + dims. */
export interface SpawnInput {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/**
 * Subset of `WebContents` the handler uses. Lets tests fake the renderer
 * sink without faking the rest of Electron.
 */
export interface TerminalSender {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): void;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface TerminalHandlersDeps {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  /** Factory invoked once per `terminal:spawn` request. */
  spawnPty: (input: SpawnInput) => PtyHandle;
  /** `process.platform` — overridable so tests can exercise win32 branch. */
  platform: NodeJS.Platform;
  /** `process.env` snapshot at registration time. */
  env: NodeJS.ProcessEnv;
  /** Used when the renderer doesn't supply `cwd`. */
  defaultCwd: () => string;
}

function defaultDeps(): TerminalHandlersDeps {
  return {
    ipc: defaultIpcMain,
    spawnPty: createDefaultPtyFactory(),
    platform: process.platform,
    env: process.env,
    defaultCwd: () => os.homedir(),
  };
}

/**
 * Lazy node-pty require. Pulled inside a factory so vitest can import
 * this module (and the IPC handlers can be unit-tested with a fake
 * `spawnPty`) without the native module being loaded — the prebuild
 * binaries are platform-specific and absent in CI snapshots.
 */
function createDefaultPtyFactory(): (input: SpawnInput) => PtyHandle {
  return (input) => {
    // Dynamic require so the native module isn't pulled into vitest.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require('node-pty') as typeof import('node-pty');
    return pty.spawn(input.shell, input.args, {
      name: 'xterm-256color',
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: input.env as { [k: string]: string },
    });
  };
}

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

interface Tracked {
  pty: PtyHandle;
  sender: TerminalSender;
  destroyedListener: () => void;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the four `terminal:*` IPC handlers. Returns a teardown closure
 * which removes the handlers AND kills any still-tracked pty. The
 * teardown is synchronous — `pty.kill()` is itself synchronous; we don't
 * wait for `event:terminal:exit` to drain because the process is going
 * away anyway.
 */
export function registerTerminalHandlers(
  deps: Partial<TerminalHandlersDeps> = {},
): () => void {
  const resolved: TerminalHandlersDeps = { ...defaultDeps(), ...deps };
  const tracked = new Map<string, Tracked>();

  resolved.ipc.handle(
    TERMINAL_CHANNELS.spawn,
    (event, req: unknown) => handleSpawn(event, req, resolved, tracked),
  );
  resolved.ipc.handle(
    TERMINAL_CHANNELS.write,
    (_event, req: unknown) => handleWrite(req, tracked),
  );
  resolved.ipc.handle(
    TERMINAL_CHANNELS.resize,
    (_event, req: unknown) => handleResize(req, tracked),
  );
  resolved.ipc.handle(
    TERMINAL_CHANNELS.dispose,
    (_event, req: unknown) => handleDispose(req, tracked),
  );

  return () => {
    resolved.ipc.removeHandler(TERMINAL_CHANNELS.spawn);
    resolved.ipc.removeHandler(TERMINAL_CHANNELS.write);
    resolved.ipc.removeHandler(TERMINAL_CHANNELS.resize);
    resolved.ipc.removeHandler(TERMINAL_CHANNELS.dispose);
    for (const id of Array.from(tracked.keys())) {
      killTracked(id, tracked);
    }
  };
}

// ---------------------------------------------------------------------------
// Shell resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the default shell + argv for the current platform.
 *
 * Exported as a pure helper so tests can pin the resolution explicitly
 * and so a future story can add a "preferred shell" setting without
 * teaching the handler about persisted preferences.
 */
export function resolveDefaultShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { shell: string; args: string[] } {
  if (platform === 'win32') {
    return { shell: env.COMSPEC ?? 'powershell.exe', args: [] };
  }
  return { shell: env.SHELL ?? '/bin/zsh', args: [] };
}

/**
 * Resolve the cwd a pty should start in.
 *
 * `cwd` arrives over IPC as `unknown`; we accept a non-empty string and
 * otherwise fall back to the platform default. Exported for tests.
 */
export function resolveCwd(
  requested: unknown,
  defaultCwd: () => string,
): string {
  if (typeof requested === 'string' && requested.length > 0) {
    return requested;
  }
  return defaultCwd();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSpawn(
  event: IpcMainInvokeEvent,
  raw: unknown,
  deps: TerminalHandlersDeps,
  tracked: Map<string, Tracked>,
): Promise<SpawnResponse> {
  const req = assertSpawnRequest(raw);
  const id = randomUUID();
  const { shell, args } = resolveDefaultShell(deps.platform, deps.env);
  const cwd = resolveCwd(req.cwd, deps.defaultCwd);

  // Forced TERM tells the spawned shell + child processes that they're
  // talking to a 256-colour xterm-compatible terminal. Critical: many
  // CLIs (vim, htop, less) gate their colour palette on $TERM, and the
  // inherited TERM from Electron's main process is often unset.
  const env: NodeJS.ProcessEnv = { ...deps.env, TERM: 'xterm-256color' };

  const pty = deps.spawnPty({ shell, args, cwd, cols: req.cols, rows: req.rows, env });
  const sender = senderFrom(event);

  const destroyedListener = (): void => {
    // Renderer window went away — kill the pty so its slave fd can be
    // reclaimed and we don't leak a zombie shell into the user's
    // process table.
    killTracked(id, tracked);
  };

  tracked.set(id, { pty, sender, destroyedListener });

  pty.onData((data) => {
    const live = tracked.get(id);
    if (!live || live.sender.isDestroyed()) return;
    const payload: TerminalDataEvent = { id, data };
    live.sender.send(EVT_TERMINAL_DATA, payload);
  });

  pty.onExit(({ exitCode, signal }) => {
    const live = tracked.get(id);
    if (!live) return;
    tracked.delete(id);
    // Detach the destroyed-listener once the pty is gone of its own
    // accord (user typed `exit`, process killed externally). Without
    // this the WebContents holds a dangling reference until window
    // close.
    try {
      // Electron's `removeListener` exists on WebContents but isn't on
      // the narrow `TerminalSender` shape; tests don't need to model it.
      const wc = live.sender as unknown as {
        removeListener?: (e: string, l: () => void) => void;
      };
      wc.removeListener?.('destroyed', live.destroyedListener);
    } catch {
      // Best-effort cleanup — never let a teardown bookkeeping bug crash
      // the main process.
    }
    if (live.sender.isDestroyed()) return;
    const payload: TerminalExitEvent = {
      id,
      exitCode: exitCode ?? null,
      signal: typeof signal === 'number' ? signal : null,
    };
    live.sender.send(EVT_TERMINAL_EXIT, payload);
  });

  sender.once('destroyed', destroyedListener);
  return { id };
}

async function handleWrite(
  raw: unknown,
  tracked: Map<string, Tracked>,
): Promise<void> {
  const req = assertWriteRequest(raw);
  const entry = tracked.get(req.id);
  if (!entry) return;
  entry.pty.write(req.data);
}

async function handleResize(
  raw: unknown,
  tracked: Map<string, Tracked>,
): Promise<void> {
  const req = assertResizeRequest(raw);
  const entry = tracked.get(req.id);
  if (!entry) return;
  // Guard against zero/negative dims — node-pty asserts internally but
  // an uncaught throw across the IPC boundary would surface as a
  // confusing Promise rejection in the renderer. Clamp to 1.
  const cols = Math.max(1, Math.floor(req.cols));
  const rows = Math.max(1, Math.floor(req.rows));
  entry.pty.resize(cols, rows);
}

async function handleDispose(
  raw: unknown,
  tracked: Map<string, Tracked>,
): Promise<void> {
  const req = assertDisposeRequest(raw);
  killTracked(req.id, tracked);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function killTracked(id: string, tracked: Map<string, Tracked>): void {
  const entry = tracked.get(id);
  if (!entry) return;
  tracked.delete(id);
  try {
    entry.pty.kill();
  } catch {
    // Process may have already exited between the user's dispose call
    // and ours. Idempotent teardown wins.
  }
  if (entry.sender.isDestroyed()) return;
  const payload: TerminalExitEvent = { id, exitCode: null, signal: null };
  try {
    entry.sender.send(EVT_TERMINAL_EXIT, payload);
  } catch {
    // Send during shutdown can throw; never let teardown throw upward.
  }
}

function senderFrom(event: IpcMainInvokeEvent): TerminalSender {
  // `WebContents` already satisfies our narrow interface; the cast just
  // lets TS verify the shape without requiring callers (or tests) to
  // implement the full WebContents API.
  const wc = event.sender as unknown as WebContents & {
    once(e: 'destroyed', l: () => void): void;
  };
  return {
    send: (ch, p) => wc.send(ch, p),
    isDestroyed: () => wc.isDestroyed(),
    once: (e, l) => wc.once(e, l),
  };
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function assertSpawnRequest(raw: unknown): SpawnRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('terminal:spawn requires an object payload');
  }
  const obj = raw as Record<string, unknown>;
  const cols = obj.cols;
  const rows = obj.rows;
  if (typeof cols !== 'number' || typeof rows !== 'number') {
    throw new TypeError('terminal:spawn requires numeric cols + rows');
  }
  const cwd = obj.cwd;
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new TypeError('terminal:spawn cwd must be a string when provided');
  }
  return { cwd, cols, rows };
}

function assertWriteRequest(raw: unknown): WriteRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('terminal:write requires an object payload');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || typeof obj.data !== 'string') {
    throw new TypeError('terminal:write requires string id + data');
  }
  return { id: obj.id, data: obj.data };
}

function assertResizeRequest(raw: unknown): ResizeRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('terminal:resize requires an object payload');
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.id !== 'string' ||
    typeof obj.cols !== 'number' ||
    typeof obj.rows !== 'number'
  ) {
    throw new TypeError('terminal:resize requires string id + numeric cols + rows');
  }
  return { id: obj.id, cols: obj.cols, rows: obj.rows };
}

function assertDisposeRequest(raw: unknown): DisposeRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('terminal:dispose requires an object payload');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string') {
    throw new TypeError('terminal:dispose requires a string id');
  }
  return { id: obj.id };
}
