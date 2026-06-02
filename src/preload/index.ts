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

const EVT_FS_CHANGED = 'event:fs-changed';

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
