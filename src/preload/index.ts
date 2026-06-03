// src/preload/index.ts
//
// Exposes `window.hive` via `contextBridge.exposeInMainWorld`. Each method
// forwards to the main process over IPC. Channel names mirror the constants
// in `src/main/{fs,project,shell,state}/*.ts` exactly — keep this file in
// sync with them whenever a new IPC slice lands.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { FsChangeEvent, FsChangeHandler, HiveBridge, Unsubscribe } from './api';

// ---------------------------------------------------------------------------
// Channel names — must match main/* exactly. Centralized here so the diff
// against main is one file when a name changes.
// ---------------------------------------------------------------------------
const FS = {
  readFile: 'ipc:hive:fs:read-file',
  writeFile: 'ipc:hive:fs:write-file',
  listDir: 'ipc:hive:fs:list-dir',
  stat: 'ipc:hive:fs:stat',
  mkdir: 'ipc:hive:fs:mkdir',
  rename: 'ipc:hive:fs:rename',
  trash: 'ipc:hive:fs:trash',
  revealInFinder: 'ipc:hive:fs:reveal-in-finder',
  exists: 'ipc:hive:fs:exists',
} as const;

const PROJECT = {
  openDialog: 'project:open-dialog',
  inspectFolder: 'project:inspect-folder',
  watch: 'project:watch',
  unwatch: 'project:unwatch',
} as const;

const SHELL = {
  openExternal: 'shell:open-external',
} as const;

const STATE = {
  get: 'state:get',
  save: 'state:save',
} as const;

const TERMINAL = {
  spawn: 'terminal:spawn',
  write: 'terminal:write',
  resize: 'terminal:resize',
  dispose: 'terminal:dispose',
} as const;

const PLUGINS = {
  list: 'plugins:list',
  installLocal: 'plugins:install-local',
  installGithub: 'plugins:install-github',
  uninstall: 'plugins:uninstall',
  readAsset: 'plugins:read-asset',
  runSetup: 'plugins:run-setup',
} as const;

const LSP = {
  start: 'lsp:start',
  write: 'lsp:write',
  stop: 'lsp:stop',
} as const;

const GIT = {
  status: 'ipc:hive:git:status',
  diff: 'ipc:hive:git:diff',
  fileShow: 'ipc:hive:git:file-show',
  stage: 'ipc:hive:git:stage',
  unstage: 'ipc:hive:git:unstage',
  discard: 'ipc:hive:git:discard',
  commit: 'ipc:hive:git:commit',
  push: 'ipc:hive:git:push',
  pull: 'ipc:hive:git:pull',
  branches: 'ipc:hive:git:branches',
  checkout: 'ipc:hive:git:checkout',
  aheadBehind: 'ipc:hive:git:ahead-behind',
} as const;

const EVT_FS_CHANGED = 'event:fs-changed';
const EVT_TERMINAL_DATA = 'event:terminal:data';
const EVT_TERMINAL_EXIT = 'event:terminal:exit';
const EVT_LSP_DATA = 'event:lsp:data';
const EVT_LSP_STDERR = 'event:lsp:stderr';
const EVT_LSP_EXIT = 'event:lsp:exit';
const EVT_PLUGINS_SETUP_PROGRESS = 'event:plugins:setup-progress';

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------
const api: HiveBridge = {
  // Resolved once at preload time so the renderer reads a plain string rather
  // than reaching across the bridge for every access.
  platform: process.platform,

  fs: {
    readFile: (path) => ipcRenderer.invoke(FS.readFile, path),
    writeFile: (path, contents) => ipcRenderer.invoke(FS.writeFile, path, contents),
    listDir: (path) => ipcRenderer.invoke(FS.listDir, path),
    stat: (path) => ipcRenderer.invoke(FS.stat, path),
    mkdir: (path) => ipcRenderer.invoke(FS.mkdir, path),
    rename: (from, to) => ipcRenderer.invoke(FS.rename, from, to),
    trash: (path) => ipcRenderer.invoke(FS.trash, path),
    revealInFinder: (path) => ipcRenderer.invoke(FS.revealInFinder, path),
    exists: (path) => ipcRenderer.invoke(FS.exists, path),
  },

  project: {
    openDialog: () => ipcRenderer.invoke(PROJECT.openDialog),
    inspectFolder: (path) => ipcRenderer.invoke(PROJECT.inspectFolder, path),
    watch: (path) => ipcRenderer.invoke(PROJECT.watch, path),
    unwatch: (watcherId) => ipcRenderer.invoke(PROJECT.unwatch, watcherId),
  },

  state: {
    get: () => ipcRenderer.invoke(STATE.get),
    save: (state) => ipcRenderer.invoke(STATE.save, state),
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke(SHELL.openExternal, url),
  },

  // The terminal bridge — REQ-004. spawn/write/resize/dispose are flat
  // request/response. The push-side (`onData`, `onExit`) subscribes to a
  // single global event channel and filters by id at the boundary, so
  // many tabs can share one `ipcRenderer.on` registration per event
  // without playing channel-name games.
  terminal: {
    spawn: (opts) => ipcRenderer.invoke(TERMINAL.spawn, opts),
    write: (id, data) => ipcRenderer.invoke(TERMINAL.write, { id, data }),
    resize: (id, cols, rows) =>
      ipcRenderer.invoke(TERMINAL.resize, { id, cols, rows }),
    dispose: (id) => ipcRenderer.invoke(TERMINAL.dispose, { id }),
    onData: (id, handler) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { id: string; data: string },
      ): void => {
        if (payload.id === id) handler(payload.data);
      };
      ipcRenderer.on(EVT_TERMINAL_DATA, listener);
      return () => ipcRenderer.removeListener(EVT_TERMINAL_DATA, listener);
    },
    onExit: (id, handler) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { id: string; exitCode: number | null; signal: number | null },
      ): void => {
        if (payload.id === id) handler({ exitCode: payload.exitCode, signal: payload.signal });
      };
      ipcRenderer.on(EVT_TERMINAL_EXIT, listener);
      return () => ipcRenderer.removeListener(EVT_TERMINAL_EXIT, listener);
    },
  },

  // The plugins bridge — REQ-006 + REQ-007. Six flat request/response
  // methods; discovery + install + uninstall + asset reads + setup-run
  // all live behind main so the renderer never touches the filesystem
  // directly. `runSetup` optionally streams progress lines back via the
  // pluginId-filtered `event:plugins:setup-progress` channel.
  plugins: {
    list: () => ipcRenderer.invoke(PLUGINS.list),
    installLocal: (path) => ipcRenderer.invoke(PLUGINS.installLocal, { path }),
    installGithub: (opts) => ipcRenderer.invoke(PLUGINS.installGithub, opts),
    uninstall: (id) => ipcRenderer.invoke(PLUGINS.uninstall, { id }),
    readAsset: (id, relPath) =>
      ipcRenderer.invoke(PLUGINS.readAsset, { id, relPath }),
    runSetup: (pluginId, onProgress) => {
      if (onProgress === undefined) {
        return ipcRenderer.invoke(PLUGINS.runSetup, { pluginId });
      }
      const listener = (
        _e: IpcRendererEvent,
        payload: { pluginId: string; message: string },
      ): void => {
        if (payload.pluginId === pluginId) onProgress(payload.message);
      };
      ipcRenderer.on(EVT_PLUGINS_SETUP_PROGRESS, listener);
      const invoke = ipcRenderer.invoke(PLUGINS.runSetup, { pluginId });
      // Detach the progress listener on resolve OR reject — otherwise
      // the next runSetup for the same id would double-fire.
      const cleanup = (): void => {
        ipcRenderer.removeListener(EVT_PLUGINS_SETUP_PROGRESS, listener);
      };
      return invoke.then(
        (v) => {
          cleanup();
          return v;
        },
        (err) => {
          cleanup();
          throw err;
        },
      );
    },
  },

  // The LSP bridge — REQ-007. Same shape as the terminal bridge —
  // opaque session ids, three id-filtered push channels for data /
  // stderr / exit. `data` is base64 so binary frames survive the IPC
  // string serialiser intact.
  lsp: {
    start: (opts) => ipcRenderer.invoke(LSP.start, opts),
    write: (sessionId, data) => ipcRenderer.invoke(LSP.write, { sessionId, data }),
    stop: (sessionId) => ipcRenderer.invoke(LSP.stop, { sessionId }),
    onData: (sessionId, handler) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { sessionId: string; data: string },
      ): void => {
        if (payload.sessionId === sessionId) handler(payload.data);
      };
      ipcRenderer.on(EVT_LSP_DATA, listener);
      return () => ipcRenderer.removeListener(EVT_LSP_DATA, listener);
    },
    onStderr: (sessionId, handler) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { sessionId: string; data: string },
      ): void => {
        if (payload.sessionId === sessionId) handler(payload.data);
      };
      ipcRenderer.on(EVT_LSP_STDERR, listener);
      return () => ipcRenderer.removeListener(EVT_LSP_STDERR, listener);
    },
    onExit: (sessionId, handler) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { sessionId: string; code: number | null; signal: number | null },
      ): void => {
        if (payload.sessionId === sessionId) {
          handler({ code: payload.code, signal: payload.signal });
        }
      };
      ipcRenderer.on(EVT_LSP_EXIT, listener);
      return () => ipcRenderer.removeListener(EVT_LSP_EXIT, listener);
    },
  },

  // Git bridge — REQ-008. Twelve flat request/response methods; the main
  // process spawns `git` subprocesses per call with `execFile` (no shell).
  git: {
    status: (repoPath) => ipcRenderer.invoke(GIT.status, { repoPath }),
    diff: (repoPath, path, ref) =>
      ipcRenderer.invoke(GIT.diff, { repoPath, path, ref }),
    fileShow: (repoPath, path, ref) =>
      ipcRenderer.invoke(GIT.fileShow, { repoPath, path, ref }),
    stage: (repoPath, paths) => ipcRenderer.invoke(GIT.stage, { repoPath, paths }),
    unstage: (repoPath, paths) =>
      ipcRenderer.invoke(GIT.unstage, { repoPath, paths }),
    discard: (repoPath, paths) =>
      ipcRenderer.invoke(GIT.discard, { repoPath, paths }),
    commit: (repoPath, message) =>
      ipcRenderer.invoke(GIT.commit, { repoPath, message }),
    push: (repoPath) => ipcRenderer.invoke(GIT.push, { repoPath }),
    pull: (repoPath) => ipcRenderer.invoke(GIT.pull, { repoPath }),
    branches: (repoPath) => ipcRenderer.invoke(GIT.branches, { repoPath }),
    checkout: (repoPath, branch, create) =>
      ipcRenderer.invoke(GIT.checkout, { repoPath, branch, create }),
    aheadBehind: (repoPath) => ipcRenderer.invoke(GIT.aheadBehind, { repoPath }),
  },

  // `onFsChange` is renderer ← main (event push), not request/response.
  // ipcRenderer.on receives every event; we filter to the renderer-facing
  // payload and hand the listener back so the caller can detach on unmount.
  onFsChange: (handler: FsChangeHandler): Unsubscribe => {
    const listener = (_e: IpcRendererEvent, payload: FsChangeEvent) => handler(payload);
    ipcRenderer.on(EVT_FS_CHANGED, listener);
    return () => ipcRenderer.removeListener(EVT_FS_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld('hive', api);

export type { HiveBridge } from './api';
