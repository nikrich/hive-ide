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
} as const;

const EVT_FS_CHANGED = 'event:fs-changed';
const EVT_TERMINAL_DATA = 'event:terminal:data';
const EVT_TERMINAL_EXIT = 'event:terminal:exit';

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

  // The plugins bridge — REQ-006. Five flat request/response methods;
  // discovery + install + uninstall + asset reads all live behind main
  // so the renderer never touches the filesystem directly.
  plugins: {
    list: () => ipcRenderer.invoke(PLUGINS.list),
    installLocal: (path) => ipcRenderer.invoke(PLUGINS.installLocal, { path }),
    installGithub: (opts) => ipcRenderer.invoke(PLUGINS.installGithub, opts),
    uninstall: (id) => ipcRenderer.invoke(PLUGINS.uninstall, { id }),
    readAsset: (id, relPath) =>
      ipcRenderer.invoke(PLUGINS.readAsset, { id, relPath }),
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
