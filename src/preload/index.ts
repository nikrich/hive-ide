// src/preload/index.ts
//
// Exposes `window.hive` via `contextBridge.exposeInMainWorld`. Each method
// forwards to the main process over IPC. Channel names mirror the constants
// in `src/main/{fs,project,shell,state}/*.ts` exactly — keep this file in
// sync with them whenever a new IPC slice lands.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  FsChangeEvent,
  FsChangeHandler,
  HiveBridge,
  HiveConnectionHandler,
  HiveEventsHandler,
  HiveLoopStatusHandler,
  HiveManagerStatusHandler,
  HiveQuestionHandler,
  HiveRunLogHandler,
  HiveRunStatusHandler,
  HiveSnapshotHandler,
  Unsubscribe,
  UpdaterStatus,
  UpdaterStatusHandler,
} from './api';
import type {
  HiveConnection,
  HiveEvent,
  HiveLoopStatus,
  HiveManagerStatusEvent,
  HiveQuestion,
  HiveRunLogEvent,
  HiveRunStatusEvent,
  HiveSnapshot,
  IndexStatus,
  NewStoryFields,
} from '../types/hive';

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

const SEARCH = {
  files: 'search:files',
  listFiles: 'search:list-files',
  replace: 'search:replace',
} as const;

const DEBUG = {
  start: 'debug:start',
  stop: 'debug:stop',
  request: 'debug:request',
  setBreakpoints: 'debug:set-breakpoints',
  setExceptionBreakpoints: 'debug:set-exception-breakpoints',
  evtEvent: 'event:debug:event',
} as const;

const SHELL = {
  openExternal: 'shell:open-external',
} as const;

const STATE = {
  get: 'state:get',
  save: 'state:save',
} as const;

const SETTINGS = {
  get: 'settings:get',
  update: 'settings:update',
  replace: 'settings:replace',
  evtChanged: 'event:settings:changed',
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
  registryFetch: 'plugins:registry-fetch',
  registryReadme: 'plugins:registry-readme',
} as const;

const UPDATER = {
  check: 'updater:check',
  quitAndInstall: 'updater:quit-and-install',
  getVersion: 'updater:get-version',
} as const;

const LSP = {
  start: 'lsp:start',
  write: 'lsp:write',
  stop: 'lsp:stop',
} as const;

const EXTHOST = {
  setEnabled: 'exthost:set-enabled',
  invoke: 'exthost:invoke',
  evtCommands: 'event:exthost:commands',
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
  commitAmend: 'ipc:hive:git:commit-amend',
  log: 'ipc:hive:git:log',
  blame: 'ipc:hive:git:blame',
  stashList: 'ipc:hive:git:stash-list',
  stashPush: 'ipc:hive:git:stash-push',
  stashApply: 'ipc:hive:git:stash-apply',
  stashPop: 'ipc:hive:git:stash-pop',
  stashDrop: 'ipc:hive:git:stash-drop',
  applyPatch: 'ipc:hive:git:apply-patch',
} as const;

const HIVE = {
  connectWorkspace: 'ipc:hive:connect-workspace',
  setWorkspace: 'ipc:hive:set-workspace',
  getSnapshot: 'ipc:hive:get-snapshot',
  evtSnapshot: 'event:hive:snapshot',
  evtEvents: 'event:hive:events',
  evtConnection: 'event:hive:connection',
} as const;

const HIVE_RUN = {
  start: 'ipc:hive:run:start',
  stop: 'ipc:hive:run:stop',
  evtStatus: 'event:hive:run:status',
  evtLog: 'event:hive:run:log',
} as const;

const HIVE_AUTHORING = {
  ensureWorkspace: 'ipc:hive:ensure-workspace',
  createStory: 'ipc:hive:create-story',
} as const;

const HIVE_LOOP = {
  start: 'ipc:hive:loop:start',
  stop: 'ipc:hive:loop:stop',
  status: 'ipc:hive:loop:status',
  answer: 'ipc:hive:answer-question',
  questions: 'ipc:hive:questions:list',
  evtStatus: 'event:hive:loop:status',
  evtQuestion: 'event:hive:run:question',
} as const;

const HIVE_MANAGER = {
  reindex: 'ipc:hive:repo:reindex',
  indexStatus: 'ipc:hive:index:status',
  evtStatus: 'event:hive:manager:status',
} as const;

const EVT_FS_CHANGED = 'event:fs-changed';
const EVT_TERMINAL_DATA = 'event:terminal:data';
const EVT_TERMINAL_EXIT = 'event:terminal:exit';
const EVT_LSP_DATA = 'event:lsp:data';
const EVT_LSP_STDERR = 'event:lsp:stderr';
const EVT_LSP_EXIT = 'event:lsp:exit';
const EVT_PLUGINS_SETUP_PROGRESS = 'event:plugins:setup-progress';
const EVT_UPDATER_STATUS = 'updater:status';

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

  // Settings bridge — E4-01. get/update/replace are flat request/response;
  // `onChange` subscribes to the main → renderer push channel so the renderer
  // reconfigures live (covers both in-app edits and external file edits).
  settings: {
    get: () => ipcRenderer.invoke(SETTINGS.get),
    update: (patch) => ipcRenderer.invoke(SETTINGS.update, patch),
    replace: (user) => ipcRenderer.invoke(SETTINGS.replace, user),
    onChange: (handler) => {
      const listener = (
        _e: IpcRendererEvent,
        settings: import('../types/settings').Settings,
      ): void => handler(settings);
      ipcRenderer.on(SETTINGS.evtChanged, listener);
      return () => ipcRenderer.removeListener(SETTINGS.evtChanged, listener);
    },
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke(SHELL.openExternal, url),
  },

  // Debug bridge — E3. Flat request/response + a single event push channel.
  debug: {
    start: (config, breakpoints) =>
      ipcRenderer.invoke(DEBUG.start, { config, breakpoints }),
    stop: () => ipcRenderer.invoke(DEBUG.stop),
    request: (command, args) =>
      ipcRenderer.invoke(DEBUG.request, { command, args }),
    setBreakpoints: (file, breakpoints) =>
      ipcRenderer.invoke(DEBUG.setBreakpoints, { file, breakpoints }),
    setExceptionBreakpoints: (filters) =>
      ipcRenderer.invoke(DEBUG.setExceptionBreakpoints, { filters }),
    onEvent: (handler) => {
      const listener = (
        _e: IpcRendererEvent,
        event: import('./api').DapEvent,
      ): void => handler(event);
      ipcRenderer.on(DEBUG.evtEvent, listener);
      return () => ipcRenderer.removeListener(DEBUG.evtEvent, listener);
    },
  },

  // Search bridge — E2-01. Flat request/response: content search + file index.
  search: {
    files: (query) => ipcRenderer.invoke(SEARCH.files, query),
    listFiles: (opts) => ipcRenderer.invoke(SEARCH.listFiles, opts),
    replace: (req) => ipcRenderer.invoke(SEARCH.replace, req),
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
    registryFetch: (url) => ipcRenderer.invoke(PLUGINS.registryFetch, { url }),
    registryReadme: (url) => ipcRenderer.invoke(PLUGINS.registryReadme, { url }),
  },

  // Updater bridge (feat/auto-updater) — three flat request/response methods
  // plus a single main → renderer status push channel. The subscription
  // pattern mirrors `settings.onChange` / `onFsChange`.
  updater: {
    check: () => ipcRenderer.invoke(UPDATER.check),
    quitAndInstall: () => ipcRenderer.invoke(UPDATER.quitAndInstall),
    getVersion: () => ipcRenderer.invoke(UPDATER.getVersion),
    onStatus: (handler: UpdaterStatusHandler) => {
      const listener = (_e: IpcRendererEvent, status: UpdaterStatus): void =>
        handler(status);
      ipcRenderer.on(EVT_UPDATER_STATUS, listener);
      return () => ipcRenderer.removeListener(EVT_UPDATER_STATUS, listener);
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

  // Extension-host bridge — E10-09 / E10-03. `setEnabled` hands the enabled
  // plugin ids to main, which activates each one's `main` entry in an isolated
  // utilityProcess and returns the resulting command ids; `invoke` runs a
  // contributed command in that process. `onCommands` fires whenever the set of
  // host-registered commands changes, so the renderer can keep the command
  // registry in sync.
  exthost: {
    setEnabled: (ids) => ipcRenderer.invoke(EXTHOST.setEnabled, { ids }),
    invoke: (command, args) => ipcRenderer.invoke(EXTHOST.invoke, { command, args }),
    onCommands: (handler) => {
      const listener = (_e: IpcRendererEvent, commands: string[]): void =>
        handler(commands);
      ipcRenderer.on(EXTHOST.evtCommands, listener);
      return () => ipcRenderer.removeListener(EXTHOST.evtCommands, listener);
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
    commitAmend: (repoPath, message) =>
      ipcRenderer.invoke(GIT.commitAmend, { repoPath, message }),
    log: (repoPath, limit) => ipcRenderer.invoke(GIT.log, { repoPath, limit }),
    blame: (repoPath, path) => ipcRenderer.invoke(GIT.blame, { repoPath, path }),
    stashList: (repoPath) => ipcRenderer.invoke(GIT.stashList, { repoPath }),
    stashPush: (repoPath, message) =>
      ipcRenderer.invoke(GIT.stashPush, { repoPath, message }),
    stashApply: (repoPath, ref) =>
      ipcRenderer.invoke(GIT.stashApply, { repoPath, ref }),
    stashPop: (repoPath, ref) => ipcRenderer.invoke(GIT.stashPop, { repoPath, ref }),
    stashDrop: (repoPath, ref) =>
      ipcRenderer.invoke(GIT.stashDrop, { repoPath, ref }),
    applyPatch: (repoPath, patch, opts) =>
      ipcRenderer.invoke(GIT.applyPatch, {
        repoPath,
        patch,
        reverse: opts?.reverse,
        cached: opts?.cached,
      }),
  },

  // Hive orchestration bridge — three request/response methods and three
  // push subscriptions (snapshot / events / connection). The subscription
  // pattern mirrors `onFsChange` exactly: ipcRenderer.on + removeListener.
  orchestration: {
    connectWorkspace: () => ipcRenderer.invoke(HIVE.connectWorkspace),
    setWorkspace: (path: string | null) => ipcRenderer.invoke(HIVE.setWorkspace, path),
    getSnapshot: () => ipcRenderer.invoke(HIVE.getSnapshot),
    onSnapshot: (handler: HiveSnapshotHandler): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, s: HiveSnapshot): void => handler(s);
      ipcRenderer.on(HIVE.evtSnapshot, listener);
      return () => ipcRenderer.removeListener(HIVE.evtSnapshot, listener);
    },
    onEvents: (handler: HiveEventsHandler): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, e: HiveEvent[]): void => handler(e);
      ipcRenderer.on(HIVE.evtEvents, listener);
      return () => ipcRenderer.removeListener(HIVE.evtEvents, listener);
    },
    onConnection: (handler: HiveConnectionHandler): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, c: HiveConnection): void => handler(c);
      ipcRenderer.on(HIVE.evtConnection, listener);
      return () => ipcRenderer.removeListener(HIVE.evtConnection, listener);
    },
  },

  // Hive worker-run bridge (slice 2a) — start/stop request/response plus two
  // push subscriptions (status / log), mirroring the orchestration pattern.
  run: {
    start: (storyId: string) => ipcRenderer.invoke(HIVE_RUN.start, { storyId }),
    stop: (runId: string) => ipcRenderer.invoke(HIVE_RUN.stop, { runId }),
    onStatus: (handler: HiveRunStatusHandler): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, e: HiveRunStatusEvent): void => handler(e);
      ipcRenderer.on(HIVE_RUN.evtStatus, listener);
      return () => ipcRenderer.removeListener(HIVE_RUN.evtStatus, listener);
    },
    onLog: (handler: HiveRunLogHandler): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, e: HiveRunLogEvent): void => handler(e);
      ipcRenderer.on(HIVE_RUN.evtLog, listener);
      return () => ipcRenderer.removeListener(HIVE_RUN.evtLog, listener);
    },
  },

  // Hive workspace bridge (slice 2c) — ensure the active project has a bound
  // `.hive` workspace. Flat request/response, mirroring `run.start`.
  workspace: {
    ensure: (projectId: string) =>
      ipcRenderer.invoke(HIVE_AUTHORING.ensureWorkspace, { projectId }),
  },

  // Hive story-authoring bridge (slice 2c) — write a new story file from the
  // New-story form fields into the workspace.
  story: {
    create: (workspacePath: string, fields: NewStoryFields) =>
      ipcRenderer.invoke(HIVE_AUTHORING.createStory, { workspacePath, fields }),
    answer: (storyId: string, answer: string) =>
      ipcRenderer.invoke(HIVE_LOOP.answer, { storyId, answer }),
  },

  // Hive autonomous run-loop bridge (slice 2b-1) — start/stop/status request/
  // response plus a status push subscription, mirroring the run bridge.
  loop: {
    start: () => ipcRenderer.invoke(HIVE_LOOP.start),
    stop: () => ipcRenderer.invoke(HIVE_LOOP.stop),
    status: () => ipcRenderer.invoke(HIVE_LOOP.status),
    onStatus: (handler: HiveLoopStatusHandler): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, s: HiveLoopStatus): void => handler(s);
      ipcRenderer.on(HIVE_LOOP.evtStatus, listener);
      return () => ipcRenderer.removeListener(HIVE_LOOP.evtStatus, listener);
    },
  },

  // Hive questions bridge (slice 2b-1) — list outstanding worker questions
  // plus a push subscription for new ones.
  questions: {
    list: () => ipcRenderer.invoke(HIVE_LOOP.questions),
    onQuestion: (handler: HiveQuestionHandler): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, q: HiveQuestion): void => handler(q);
      ipcRenderer.on(HIVE_LOOP.evtQuestion, listener);
      return () => ipcRenderer.removeListener(HIVE_LOOP.evtQuestion, listener);
    },
  },

  // Hive repo-index bridge (slice 2b-2a) — reindex + status request/response.
  repo: {
    reindex: (repo: string) => ipcRenderer.invoke(HIVE_MANAGER.reindex, { repo }),
  },

  index: {
    status: (): Promise<Record<string, IndexStatus>> =>
      ipcRenderer.invoke(HIVE_MANAGER.indexStatus),
  },

  // Hive manager-status bridge (slice 2b-2a) — a single push subscription,
  // mirroring the loop bridge's onStatus.
  manager: {
    onStatus: (handler: HiveManagerStatusHandler): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, e: HiveManagerStatusEvent): void => handler(e);
      ipcRenderer.on(HIVE_MANAGER.evtStatus, listener);
      return () => ipcRenderer.removeListener(HIVE_MANAGER.evtStatus, listener);
    },
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
