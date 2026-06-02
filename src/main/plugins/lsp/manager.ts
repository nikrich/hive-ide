/**
 * LSP IPC handlers + per-process registry — REQ-007.
 *
 * Three request/response channels and three main → renderer event
 * channels glue the renderer's `lspClient.ts` to the spawned server
 * children.
 *
 *   - `lsp:start`            → resolves to `{ sessionId }`. Reuses any
 *                              running session keyed by
 *                              `${pluginId}:${language}` so the same
 *                              process serves every open file of the
 *                              language.
 *   - `lsp:write`            → byte-blob to the server's stdin.
 *   - `lsp:stop`             → dispose by `sessionId`.
 *   - `plugins:run-setup`    → run a plugin's `setup.downloads`,
 *                              optionally streaming progress lines back
 *                              over `event:plugins:setup-progress`.
 *
 *   - `event:lsp:data`       → server stdout chunk.
 *   - `event:lsp:stderr`     → server stderr chunk.
 *   - `event:lsp:exit`       → process exit; the renderer rebuilds its
 *                              client on the next lazy start.
 *
 * **Framing is the renderer's problem.** This module forwards raw bytes
 * (encoded base64 over the IPC channel so binary frames don't get
 * mangled by Electron's string serialiser). The renderer's `lspClient`
 * uses vscode-jsonrpc framing to parse LSP frames out of the stream.
 *
 * **Path safety.** The `command` and `cwd` templates from the manifest
 * are user-supplied. We re-load the plugin from disk (using the trusted
 * loader) before spawning so the manifest in memory matches what's
 * physically there, then run `expandCommandPath` / `expandCwd` to assert
 * the result stays inside the plugin folder.
 */

import { randomUUID } from 'node:crypto';

import {
  ipcMain as defaultIpcMain,
  type App,
  type BrowserWindow,
  type IpcMain,
} from 'electron';

import type {
  LoadedPlugin,
  PluginLanguageServerContribution,
} from '../../../types/workspace';
import { loadPlugin } from '../loader';
import { pluginDirFor } from '../storage';
import {
  LspServerProcess,
  expandArgs,
  expandCommandPath,
  expandCwd,
  type LspServerProcessOptions,
} from './process';
import { runPluginSetup, type SetupProgress } from './setup';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const LSP_CHANNELS = {
  start: 'lsp:start',
  write: 'lsp:write',
  stop: 'lsp:stop',
  runSetup: 'plugins:run-setup',
} as const;

export const EVT_LSP_DATA = 'event:lsp:data' as const;
export const EVT_LSP_STDERR = 'event:lsp:stderr' as const;
export const EVT_LSP_EXIT = 'event:lsp:exit' as const;
export const EVT_PLUGINS_SETUP_PROGRESS = 'event:plugins:setup-progress' as const;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface LspStartRequest {
  pluginId: string;
  language: string;
  /**
   * Renderer-resolved cwd template when the manifest contribution has no
   * `cwd` set — typically the first repo of the active project. Plain
   * absolute path; main verifies it exists.
   */
  defaultCwd?: string;
}

export interface LspStartResponse {
  sessionId: string;
  /**
   * The manifest's `initializationOptions` — main returns it so the
   * renderer can feed it into the LSP `initialize` request without
   * re-reading the manifest itself.
   */
  initializationOptions: unknown;
}

export interface LspWriteRequest {
  sessionId: string;
  /** Base64-encoded payload (the renderer already framed it). */
  data: string;
}

export interface LspStopRequest {
  sessionId: string;
}

export interface LspDataEvent {
  sessionId: string;
  /** Base64-encoded chunk from the server. */
  data: string;
}

export interface LspStderrEvent {
  sessionId: string;
  data: string;
}

export interface LspExitEvent {
  sessionId: string;
  code: number | null;
  signal: number | null;
}

export interface RunSetupRequest {
  pluginId: string;
}

export interface SetupProgressEvent {
  pluginId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface LspHandlersOptions {
  app: App;
  hiveVersion: string;
  getMainWindow: () => BrowserWindow | null;
}

export interface LspHandlersDeps {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  /** Factory used to spawn a server. Overridable for tests. */
  spawnServer: (opts: LspServerProcessOptions) => LspServerProcess;
  /** Loader hook so tests can inject a pre-built plugin record. */
  loadPlugin: (rootPath: string, hiveVersion: string) => Promise<LoadedPlugin | null>;
  /** Setup hook — same `runPluginSetup` shape; overridable for tests. */
  runSetup: (plugin: LoadedPlugin, onProgress?: SetupProgress) => Promise<void>;
}

function defaultDeps(): LspHandlersDeps {
  return {
    ipc: defaultIpcMain,
    spawnServer: (opts) => new LspServerProcess(opts),
    loadPlugin,
    runSetup: runPluginSetup,
  };
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface Session {
  sessionId: string;
  pluginId: string;
  language: string;
  process: LspServerProcess;
  initializationOptions: unknown;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Register the four `lsp:*` / `plugins:run-setup` IPC handlers. Returns
 * a synchronous teardown closure that removes every registration AND
 * disposes any still-running server. Call it from `before-quit`.
 */
export function registerLspHandlers(
  opts: LspHandlersOptions,
  deps: Partial<LspHandlersDeps> = {},
): () => void {
  const resolved: LspHandlersDeps = { ...defaultDeps(), ...deps };
  const sessions = new Map<string, Session>();
  /** Reverse-index — `${pluginId}:${language}` → sessionId. */
  const sessionByKey = new Map<string, string>();

  resolved.ipc.handle(
    LSP_CHANNELS.start,
    async (_event, raw: unknown): Promise<LspStartResponse> => {
      const req = assertStartRequest(raw);
      const key = `${req.pluginId}:${req.language}`;
      const existingId = sessionByKey.get(key);
      if (existingId !== undefined) {
        const existing = sessions.get(existingId);
        if (existing !== undefined && !existing.process.exited) {
          return {
            sessionId: existing.sessionId,
            initializationOptions: existing.initializationOptions,
          };
        }
        // Stale registry entry — clean up before retrying.
        sessionByKey.delete(key);
        if (existingId !== undefined) sessions.delete(existingId);
      }

      const plugin = await loadValidPlugin(opts, resolved, req.pluginId);
      const contribution = findContribution(plugin, req.language);

      const spawnOpts = buildSpawnOptions(plugin, contribution, req.defaultCwd);
      const proc = resolved.spawnServer(spawnOpts);

      const sessionId = randomUUID();
      const session: Session = {
        sessionId,
        pluginId: req.pluginId,
        language: req.language,
        process: proc,
        initializationOptions: contribution.initializationOptions ?? null,
      };
      sessions.set(sessionId, session);
      sessionByKey.set(key, sessionId);

      wireProcessStreams(session, sessions, sessionByKey, opts.getMainWindow);
      return {
        sessionId,
        initializationOptions: session.initializationOptions,
      };
    },
  );

  resolved.ipc.handle(
    LSP_CHANNELS.write,
    async (_event, raw: unknown): Promise<void> => {
      const req = assertWriteRequest(raw);
      const session = sessions.get(req.sessionId);
      if (session === undefined) return;
      const buf = Buffer.from(req.data, 'base64');
      session.process.stdin.write(buf);
    },
  );

  resolved.ipc.handle(
    LSP_CHANNELS.stop,
    async (_event, raw: unknown): Promise<void> => {
      const req = assertStopRequest(raw);
      disposeSession(req.sessionId, sessions, sessionByKey);
    },
  );

  resolved.ipc.handle(
    LSP_CHANNELS.runSetup,
    async (_event, raw: unknown): Promise<void> => {
      const req = assertRunSetupRequest(raw);
      const plugin = await loadValidPlugin(opts, resolved, req.pluginId);
      const win = opts.getMainWindow();
      const send: SetupProgress = (message) => {
        if (win === null || win.isDestroyed()) return;
        const payload: SetupProgressEvent = { pluginId: req.pluginId, message };
        win.webContents.send(EVT_PLUGINS_SETUP_PROGRESS, payload);
      };
      await resolved.runSetup(plugin, send);
    },
  );

  return () => {
    resolved.ipc.removeHandler(LSP_CHANNELS.start);
    resolved.ipc.removeHandler(LSP_CHANNELS.write);
    resolved.ipc.removeHandler(LSP_CHANNELS.stop);
    resolved.ipc.removeHandler(LSP_CHANNELS.runSetup);
    for (const id of Array.from(sessions.keys())) {
      disposeSession(id, sessions, sessionByKey);
    }
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadValidPlugin(
  opts: LspHandlersOptions,
  deps: LspHandlersDeps,
  pluginId: string,
): Promise<LoadedPlugin> {
  const root = pluginDirFor(opts.app, pluginId);
  const plugin = await deps.loadPlugin(root, opts.hiveVersion);
  if (plugin === null) {
    throw new Error(`lsp: plugin "${pluginId}" is not installed`);
  }
  if (!plugin.valid) {
    throw new Error(
      `lsp: plugin "${pluginId}" is not valid (${plugin.invalidReason ?? 'unknown reason'})`,
    );
  }
  return plugin;
}

function findContribution(
  plugin: LoadedPlugin,
  language: string,
): PluginLanguageServerContribution {
  const servers = plugin.manifest.contributes?.languageServers ?? [];
  const match = servers.find((s) => s.language === language);
  if (match === undefined) {
    throw new Error(
      `lsp: plugin "${plugin.manifest.id}" does not contribute a server for language "${language}"`,
    );
  }
  if (match.transport !== undefined && match.transport !== 'stdio') {
    throw new Error(
      `lsp: plugin "${plugin.manifest.id}" requested transport "${match.transport}" — only "stdio" is supported`,
    );
  }
  return match;
}

function buildSpawnOptions(
  plugin: LoadedPlugin,
  contribution: PluginLanguageServerContribution,
  defaultCwd: string | undefined,
): LspServerProcessOptions {
  const command = expandCommandPath(contribution.command, plugin.rootPath);
  const args = expandArgs(contribution.args ?? [], plugin.rootPath);

  let cwd: string;
  if (contribution.cwd !== undefined) {
    cwd = expandCwd(contribution.cwd, plugin.rootPath);
  } else if (defaultCwd !== undefined && defaultCwd.length > 0) {
    cwd = defaultCwd;
  } else {
    cwd = plugin.rootPath;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...contribution.env };
  return { command, args, cwd, env };
}

function wireProcessStreams(
  session: Session,
  sessions: Map<string, Session>,
  sessionByKey: Map<string, string>,
  getMainWindow: () => BrowserWindow | null,
): void {
  const sendData = (channel: string, payload: unknown): void => {
    const win = getMainWindow();
    if (win === null || win.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // ignore send-during-shutdown
    }
  };

  session.process.stdout.on('data', (chunk: Buffer) => {
    const payload: LspDataEvent = {
      sessionId: session.sessionId,
      data: chunk.toString('base64'),
    };
    sendData(EVT_LSP_DATA, payload);
  });
  session.process.stderr.on('data', (chunk: Buffer) => {
    const payload: LspStderrEvent = {
      sessionId: session.sessionId,
      data: chunk.toString('utf8'),
    };
    sendData(EVT_LSP_STDERR, payload);
  });

  session.process.onExit(({ code, signal }) => {
    sessions.delete(session.sessionId);
    const key = `${session.pluginId}:${session.language}`;
    if (sessionByKey.get(key) === session.sessionId) {
      sessionByKey.delete(key);
    }
    const payload: LspExitEvent = {
      sessionId: session.sessionId,
      code,
      signal: typeof signal === 'number' ? signal : null,
    };
    sendData(EVT_LSP_EXIT, payload);
  });
}

function disposeSession(
  sessionId: string,
  sessions: Map<string, Session>,
  sessionByKey: Map<string, string>,
): void {
  const session = sessions.get(sessionId);
  if (session === undefined) return;
  sessions.delete(sessionId);
  const key = `${session.pluginId}:${session.language}`;
  if (sessionByKey.get(key) === sessionId) {
    sessionByKey.delete(key);
  }
  try {
    session.process.dispose();
  } catch {
    // never let dispose throw upward
  }
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function assertStartRequest(raw: unknown): LspStartRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('lsp:start requires an object payload');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.pluginId !== 'string' || obj.pluginId.length === 0) {
    throw new TypeError('lsp:start requires { pluginId: string }');
  }
  if (typeof obj.language !== 'string' || obj.language.length === 0) {
    throw new TypeError('lsp:start requires { language: string }');
  }
  const defaultCwd =
    typeof obj.defaultCwd === 'string' && obj.defaultCwd.length > 0
      ? obj.defaultCwd
      : undefined;
  return { pluginId: obj.pluginId, language: obj.language, defaultCwd };
}

function assertWriteRequest(raw: unknown): LspWriteRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('lsp:write requires an object payload');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0) {
    throw new TypeError('lsp:write requires a string sessionId');
  }
  if (typeof obj.data !== 'string') {
    throw new TypeError('lsp:write requires base64 string data');
  }
  return { sessionId: obj.sessionId, data: obj.data };
}

function assertStopRequest(raw: unknown): LspStopRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('lsp:stop requires an object payload');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0) {
    throw new TypeError('lsp:stop requires a string sessionId');
  }
  return { sessionId: obj.sessionId };
}

function assertRunSetupRequest(raw: unknown): RunSetupRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('plugins:run-setup requires an object payload');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.pluginId !== 'string' || obj.pluginId.length === 0) {
    throw new TypeError('plugins:run-setup requires a string pluginId');
  }
  return { pluginId: obj.pluginId };
}
