// src/preload/index.ts
//
// Exposes `window.hive` via `contextBridge.exposeInMainWorld`. Every method
// is a stub that throws `'not implemented: hive.<member>'`. This is intentional:
// later main-process stories (STORY-017, STORY-018, STORY-019) implement each
// slice via `ipcRenderer.invoke('ipc:hive:<channel>', …)`. Until they land,
// any accidental call from the renderer fails loudly instead of silently
// returning undefined.

import { contextBridge } from 'electron';
import type {
  FsChangeHandler,
  HiveBridge,
  Unsubscribe,
} from './api';

export type { HiveBridge } from './api';

function notImplemented(member: string): never {
  throw new Error(`not implemented: hive.${member}`);
}

const api: HiveBridge = {
  // `process.platform` is resolved once at preload time so the renderer sees
  // a plain string rather than reaching across the bridge for every read.
  platform: process.platform,

  fs: {
    readFile: () => notImplemented('fs.readFile'),
    writeFile: () => notImplemented('fs.writeFile'),
    listDir: () => notImplemented('fs.listDir'),
    stat: () => notImplemented('fs.stat'),
    mkdir: () => notImplemented('fs.mkdir'),
    rename: () => notImplemented('fs.rename'),
    trash: () => notImplemented('fs.trash'),
    revealInFinder: () => notImplemented('fs.revealInFinder'),
    exists: () => notImplemented('fs.exists'),
  },

  project: {
    openDialog: () => notImplemented('project.openDialog'),
    detect: () => notImplemented('project.detect'),
    watch: () => notImplemented('project.watch'),
    unwatch: () => notImplemented('project.unwatch'),
  },

  state: {
    get: () => notImplemented('state.get'),
    save: () => notImplemented('state.save'),
  },

  shell: {
    openExternal: () => notImplemented('shell.openExternal'),
  },

  onFsChange: (_handler: FsChangeHandler): Unsubscribe =>
    notImplemented('onFsChange'),
};

contextBridge.exposeInMainWorld('hive', api);
