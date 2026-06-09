// src/preload/api.ts
//
// The renderer ↔ main contract. This file is the single source of truth for
// the shape of `window.hive`.
//
// REQ-003 redirected the project model: a project is now a user-named
// container of repos, not a folder-with-auto-detected-repos. The bridge's
// `project` namespace lost `detect()` (which constructed a Project) and
// gained `inspectFolder()` (which only reports facts about a single folder).
// The full Project lifecycle now lives in the renderer's Zustand store.

// ---------------------------------------------------------------------------
// Workspace domain types
// ---------------------------------------------------------------------------

export interface Repo {
  /** Default: `basename(path)`. */
  name: string;
  /** Absolute path. */
  path: string;
  /** Whether the directory contains a `.git/` subdirectory. */
  isGitRepo: boolean;
}

export interface Project {
  /** `crypto.randomUUID()` assigned at creation time. */
  id: string;
  /** User-given name, non-empty. */
  name: string;
  repos: Repo[];
  /** Unix milliseconds. */
  createdAt: number;
  /** Unix milliseconds. */
  lastOpenedAt: number;
}

export interface RecentEntry {
  id: string;
  name: string;
  repoCount: number;
  lastOpenedAt: number;
}

/** Result of `project:inspect-folder`. */
export interface InspectedFolder {
  /** Absolute path. */
  path: string;
  /** `basename(path)`. */
  name: string;
  /** True if `<path>/.git/` exists. */
  isGitRepo: boolean;
}

// ---------------------------------------------------------------------------
// Git (REQ-008) — re-exported from shared types so preload is the one
// place a renderer-side caller has to import from.
// ---------------------------------------------------------------------------

export type { GitStatusEntry } from '../types/workspace';

// Terminal-session persisted shapes (schema v6) — imported from shared types
// so the preload `ProjectSession` can reference them without duplicating the
// (recursive) pane-tree definitions, and re-exported so renderer callers keep
// importing every persisted shape from this one bridge module.
import type {
  PanelTerminalTab,
  TermSessionSnapshot,
} from '../types/workspace';
export type { PanelTerminalTab, TermSessionSnapshot };

// ---------------------------------------------------------------------------
// Hive orchestration types — re-exported so the renderer imports from here.
// ---------------------------------------------------------------------------

export type { HiveConnection, HiveEvent, HiveSessionBundle, HiveSnapshot } from '../types/hive';
export type { HiveRunLogEvent, HiveRunStatus, HiveRunStatusEvent } from '../types/hive';
export type { IndexStatus, HiveManagerStatusEvent } from '../types/hive';
export type { NewRequirementFields } from '../types/hive';

// ---------------------------------------------------------------------------
// Filesystem types
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  /** Absolute path. */
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Unix milliseconds. */
  mtime: number;
}

export interface Stat {
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  /** Unix milliseconds. */
  mtime: number;
  /** Unix milliseconds. */
  ctime: number;
}

export interface FileContents {
  contents: string;
  encoding: 'utf8' | 'binary';
}

// ---------------------------------------------------------------------------
// Persistence types
// ---------------------------------------------------------------------------

/**
 * Opaque Monaco view-state. We deliberately treat it as `unknown` at the
 * bridge boundary so the preload surface stays free of any Monaco import.
 * The renderer narrows it when it hands the value to Monaco.
 */
export type MonacoViewState = unknown;

export interface OpenTabSnapshot {
  /** Absolute file path. */
  path: string;
  viewState: MonacoViewState | null;
}

export interface ProjectSession {
  id: string;
  name: string;
  repos: Repo[];
  createdAt: number;
  lastOpenedAt: number;
  /** Absolute folder paths that should be expanded in the tree on restore. */
  expandedPaths: string[];
  openTabs: OpenTabSnapshot[];
  activeTabPath: string | null;
  /** Secondary (split) group tabs (E5-09). */
  secondaryTabs?: OpenTabSnapshot[];
  /** Active tab in the secondary group (E5-09). */
  secondaryActiveTabPath?: string | null;
  /** Absolute path of the bound hive workspace, if any. */
  hiveWorkspacePath?: string;
  /** View that was foreground on close (schema v5). Absent → 'ide'. */
  activeView?: 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term' | 'search' | 'debug';
  /** Whether the bottom panel was open (schema v5). Absent → true. */
  panelOpen?: boolean;
  /** Active bottom-panel tab (schema v5). Absent → 'log'. */
  panelTab?: 'terminal' | 'log' | 'problems';
}

/**
 * Workspace-global terminal state (schema v6). Terminal sessions moved out of
 * `ProjectSession` so they are shared across projects and survive a swap.
 * Fresh shells re-spawn on restore from the persisted layout.
 */
export interface TerminalsSnapshot {
  panelTerminals: PanelTerminalTab[];
  activePanelTerminalId: string | null;
  termSessions: TermSessionSnapshot[];
  activeTermSessionId: string | null;
}

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/**
 * Workspace-level IDE layout snapshot (REQ-005).
 *
 * Persisted at the workspace level — one panel-size profile per install,
 * regardless of which project is open. Pixels.
 */
export interface LayoutSnapshot {
  explorerWidth: number;
  dockWidth: number;
  panelHeight: number;
}

export interface PersistedState {
  schemaVersion: 6;
  lastProjectId: string | null;
  recents: RecentEntry[];
  projects: Record<string, ProjectSession>;
  layout: LayoutSnapshot;
  /**
   * Per-workspace plugin enable state, keyed by `Project.id`. REQ-006.
   */
  enabledPlugins: Record<string, string[]>;
  /** Workspace-global terminal state (shared across projects). REQ-010. */
  terminals: TerminalsSnapshot;
  window: WindowBounds;
}

// ---------------------------------------------------------------------------
// Plugins (REQ-006)
// ---------------------------------------------------------------------------

/**
 * Manifest published by a plugin in its `plugin.json` file. The renderer
 * never parses the manifest itself — main does, and hands a validated
 * record back via `plugins:list`.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  engines?: { hive?: string };
  /** Other plugin ids this plugin depends on (E10-08). */
  dependencies?: string[];
  /** Entry module run in the extension host (E10-09). */
  main?: string;
  contributes?: {
    languages?: PluginLanguageContribution[];
    languageServers?: PluginLanguageServerContribution[];
    /** Default keybindings the plugin contributes (E10-04). */
    keybindings?: PluginKeybindingContribution[];
    /** Commands the plugin's `main` registers in the extension host (E10-03). */
    commands?: PluginCommandContribution[];
  };
  /** REQ-007 — one-time setup steps (currently just file downloads). */
  setup?: {
    downloads?: PluginSetupDownload[];
  };
}

export interface PluginLanguageContribution {
  id: string;
  extensions?: string[];
  aliases?: string[];
  configuration?: string;
  grammar?: string;
}

/** A keybinding a plugin contributes (E10-04). */
export interface PluginKeybindingContribution {
  /** Command id to run (built-in or another plugin's). */
  command: string;
  /** Default chord, e.g. `ctrl+alt+t` (canonical `mod+...` form preferred). */
  key: string;
  /** macOS-specific chord override. */
  mac?: string;
  /** Optional when-clause. */
  when?: string;
}

/** A command a plugin contributes (E10-03), handled by its extension host. */
export interface PluginCommandContribution {
  command: string;
  title: string;
  category?: string;
}

export interface PluginLanguageServerContribution {
  language: string;
  command: string;
  args?: string[];
  transport?: 'stdio' | 'socket';
  /** Verbatim opaque JSON sent in the LSP initialize request. REQ-007. */
  initializationOptions?: unknown;
  /** Override for the server's cwd (`${pluginDir}` expanded). REQ-007. */
  cwd?: string;
  /** Extra env vars merged into the server's environment. REQ-007. */
  env?: Record<string, string>;
}

export interface PluginSetupDownload {
  url: string;
  extractTo: string;
  sha256?: string;
  archive?: 'tar.gz' | 'zip' | 'none';
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  rootPath: string;
  valid: boolean;
  invalidReason?: string;
}

// ---------------------------------------------------------------------------
// Filesystem watcher event
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hive orchestration handler types + bridge
// ---------------------------------------------------------------------------

export type HiveSnapshotHandler = (snapshot: import('../types/hive').HiveSnapshot) => void;
export type HiveEventsHandler = (events: import('../types/hive').HiveEvent[]) => void;
export type HiveConnectionHandler = (connection: import('../types/hive').HiveConnection) => void;

export interface HiveOrchestrationBridge {
  /** Open a directory picker, validate `<dir>/.hive`, start watching. */
  connectWorkspace(): Promise<{ connection: import('../types/hive').HiveConnection }>;
  /** Re-point at a workspace path (or null to disconnect). */
  setWorkspace(path: string | null): Promise<import('../types/hive').HiveSessionBundle>;
  /** Current bundle for cold subscribers. */
  getSnapshot(): Promise<import('../types/hive').HiveSessionBundle>;
  onSnapshot(handler: HiveSnapshotHandler): Unsubscribe;
  onEvents(handler: HiveEventsHandler): Unsubscribe;
  onConnection(handler: HiveConnectionHandler): Unsubscribe;
}

export type HiveRunStatusHandler = (event: import('../types/hive').HiveRunStatusEvent) => void;
export type HiveRunLogHandler = (event: import('../types/hive').HiveRunLogEvent) => void;

/**
 * Hive worker-run bridge (slice 2a) — start/stop a native worker run for a
 * story plus two id-agnostic push channels (status / log). The subscription
 * pattern mirrors the orchestration bridge: ipcRenderer.on + removeListener.
 */
export interface HiveRunBridge {
  /** Start a worker run for `storyId`; resolves with the assigned run id. */
  start(storyId: string): Promise<{ runId: string }>;
  /** Stop the run identified by `runId`. */
  stop(runId: string): Promise<void>;
  onStatus(handler: HiveRunStatusHandler): Unsubscribe;
  onLog(handler: HiveRunLogHandler): Unsubscribe;
}

/**
 * Hive workspace bridge (slice 2c) — ensure the active project has a bound
 * `.hive` workspace, creating it (and pointing the slice-1 reader at it) when
 * absent. Resolves with the absolute workspace path.
 */
export interface HiveWorkspaceBridge {
  ensure(projectId: string): Promise<{ workspacePath: string }>;
}

/**
 * Hive story-authoring bridge (slice 2c) — write a new story file into the
 * workspace from the New-story form fields. Resolves with the assigned id.
 */
export interface HiveStoryBridge {
  create(
    workspacePath: string,
    fields: import('../types/hive').NewStoryFields,
  ): Promise<{ storyId: string }>;
  /** Answer a worker's blocking question for `storyId`. */
  answer(storyId: string, answer: string): Promise<void>;
}

export type HiveLoopStatusHandler = (s: import('../types/hive').HiveLoopStatus) => void;
export type HiveQuestionHandler = (q: import('../types/hive').HiveQuestion) => void;

/**
 * Hive autonomous run-loop bridge (slice 2b-1) — start/stop the supervisor's
 * loop plus a status push channel. Mirrors the run bridge's subscription
 * pattern: ipcRenderer.on + removeListener with the same listener reference.
 */
export interface HiveLoopBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<import('../types/hive').HiveLoopStatus>;
  onStatus(handler: HiveLoopStatusHandler): () => void;
}

/**
 * Hive questions bridge (slice 2b-1) — list outstanding worker questions plus
 * a push channel for new ones.
 */
export interface HiveQuestionsBridge {
  list(): Promise<import('../types/hive').HiveQuestion[]>;
  onQuestion(handler: HiveQuestionHandler): () => void;
}

/**
 * Hive requirement bridge (slice 2b-2b) — author a high-level requirement (→ a
 * decompose job on the manager lane) and approve/discard the proposed plan.
 * Flat request/response, mirroring the story/loop bridges.
 */
export interface HiveRequirementBridge {
  /** Write the requirement + enqueue decompose; resolves with the new id. */
  create(fields: import('../types/hive').NewRequirementFields): Promise<string>;
  /** Approve the proposed plan: stories → pending, requirement → in-flight. */
  approve(reqId: string): Promise<void>;
  /** Discard the proposed plan: delete proposed stories + the requirement. */
  discard(reqId: string): Promise<void>;
}

export type HiveManagerStatusHandler = (e: import('../types/hive').HiveManagerStatusEvent) => void;

/**
 * Hive repo-index bridge (slice 2b-2a) — trigger a manual re-index for one
 * repo, read the per-repo index-status map, and subscribe to manager-lane
 * status pushes. Subscription mirrors the loop bridge (on + removeListener).
 */
export interface HiveRepoBridge {
  reindex(repo: string): Promise<void>;
}

export interface HiveIndexBridge {
  status(): Promise<Record<string, import('../types/hive').IndexStatus>>;
}

export interface HiveManagerBridge {
  onStatus(handler: HiveManagerStatusHandler): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Filesystem watcher event
// ---------------------------------------------------------------------------

export type FsChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface FsChangeEvent {
  /** Absolute path of the affected entry. */
  path: string;
  kind: FsChangeKind;
}

export type FsChangeHandler = (event: FsChangeEvent) => void;

/** Returned by `onFsChange` so callers can unsubscribe. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Bridge surface
// ---------------------------------------------------------------------------

export interface HiveFsBridge {
  readFile(path: string): Promise<FileContents>;
  writeFile(path: string, contents: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<Stat>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface HiveProjectBridge {
  openDialog(): Promise<{ canceled: boolean; path?: string }>;
  /** Report facts about a folder the user picked. Does NOT create a Project. */
  inspectFolder(path: string): Promise<InspectedFolder>;
  /** Returns an opaque watcherId. */
  watch(path: string): Promise<string>;
  unwatch(watcherId: string): Promise<void>;
}

export interface HiveStateBridge {
  get(): Promise<PersistedState>;
  save(state: PersistedState): Promise<void>;
}

// ---------------------------------------------------------------------------
// Settings (E4-01) — re-exported from shared types so renderer callers import
// every settings shape from this one bridge module.
// ---------------------------------------------------------------------------

export type {
  Settings,
  PartialSettings,
  SettingDescriptor,
  SettingsCategory,
} from '../types/settings';

import type { Settings, PartialSettings } from '../types/settings';

/** Result of `settings:get` — merged settings + raw user layer + file path. */
export interface SettingsBundle {
  settings: Settings;
  /** The raw user override layer (contents of `settings.json`). */
  user: PartialSettings;
  /** Absolute path of `settings.json` — used by the JSON escape hatch. */
  path: string;
}

export type SettingsChangedHandler = (settings: Settings) => void;

/**
 * Settings bridge — E4-01. `get` returns the merged settings + raw user layer
 * + on-disk path; `update` merges a patch into the user layer; `replace` swaps
 * the entire user layer (used by the JSON escape hatch). `onChange` pushes the
 * merged settings whenever they change, including external file edits.
 */
export interface HiveSettingsBridge {
  get(): Promise<SettingsBundle>;
  update(patch: PartialSettings): Promise<Settings>;
  replace(user: PartialSettings): Promise<Settings>;
  onChange(handler: SettingsChangedHandler): Unsubscribe;
}

export interface HiveShellBridge {
  openExternal(url: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Debug (E3-01)
// ---------------------------------------------------------------------------

export interface DapEvent {
  event: string;
  body?: unknown;
}

export type DebugEventHandler = (event: DapEvent) => void;

/**
 * Debug bridge — E3. `start` launches an adapter for a config (with the current
 * breakpoints), `request` forwards a raw DAP request to the active session
 * (continue/next/stepIn/stackTrace/scopes/variables/evaluate/…), and `onEvent`
 * streams adapter events (stopped/output/terminated/…) to the renderer.
 */
/** A source breakpoint as sent to the adapter (E3-03, E3-10). */
export interface SourceBreakpoint {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface HiveDebugBridge {
  start(
    config: import('../types/launch').DebugConfiguration,
    breakpoints: Record<string, SourceBreakpoint[]>,
  ): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
  request(command: string, args?: unknown): Promise<unknown>;
  setBreakpoints(file: string, breakpoints: SourceBreakpoint[]): Promise<void>;
  /** Exception breakpoint filters (E3-11), e.g. ['uncaught']. */
  setExceptionBreakpoints(filters: string[]): Promise<void>;
  onEvent(handler: DebugEventHandler): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Search (E2-01)
// ---------------------------------------------------------------------------

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface SearchMatchRange {
  start: number;
  end: number;
}

export interface SearchLineMatch {
  /** 1-based line number. */
  line: number;
  preview: string;
  ranges: SearchMatchRange[];
  /** Context lines before/after the match (E2-10). */
  before?: string[];
  after?: string[];
}

export interface SearchFileResult {
  /** Absolute file path. */
  file: string;
  matches: SearchLineMatch[];
}

export interface SearchResult {
  results: SearchFileResult[];
  truncated: boolean;
  total: number;
}

export interface SearchQuery {
  roots: string[];
  query: string;
  options?: SearchOptions;
  exclude?: string[];
  maxResults?: number;
  maxFiles?: number;
  /** Lines of context around each match (E2-10). */
  contextLines?: number;
}

/**
 * Search bridge — E2-01. `files` runs a content search across the roots;
 * `listFiles` returns the flat file index used by quick-open (⌘P).
 */
export interface HiveSearchBridge {
  files(query: SearchQuery): Promise<SearchResult>;
  listFiles(opts: {
    roots: string[];
    exclude?: string[];
    max?: number;
  }): Promise<{ files: string[]; truncated: boolean }>;
  /** Apply a find/replace across the given files (E2-04). */
  replace(req: {
    files: string[];
    query: string;
    replacement: string;
    options?: SearchOptions;
  }): Promise<{ filesChanged: number; replacements: number }>;
}

/**
 * Terminal bridge — REQ-004. Each `spawn` returns an opaque `id`. The
 * renderer threads that id back into every subsequent call so the main
 * process can route writes / resizes to the right pty and the renderer
 * can filter incoming `event:terminal:data` chunks by owner.
 */
export interface HiveTerminalBridge {
  spawn(opts: { cwd?: string; cols: number; rows: number }): Promise<{ id: string }>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  dispose(id: string): Promise<void>;
  /** Subscribe to data chunks for a specific terminal id. Returns unsubscribe. */
  onData(id: string, handler: (data: string) => void): Unsubscribe;
  /** Subscribe to exit events for a specific terminal id. Returns unsubscribe. */
  onExit(
    id: string,
    handler: (exit: { exitCode: number | null; signal: number | null }) => void,
  ): Unsubscribe;
}

/**
 * Plugins bridge — REQ-006. Five flat request/response methods: list,
 * install (local or github), uninstall, and read-asset (used by the
 * renderer to pull a plugin's grammar / language-configuration JSON
 * without granting it direct filesystem access).
 */
export interface HivePluginsBridge {
  list(): Promise<LoadedPlugin[]>;
  installLocal(path: string): Promise<LoadedPlugin>;
  installGithub(opts: {
    owner: string;
    repo: string;
    tag?: string;
  }): Promise<LoadedPlugin>;
  uninstall(id: string): Promise<void>;
  readAsset(id: string, relPath: string): Promise<string>;
  /**
   * Run a plugin's declared `setup.downloads` — REQ-007. Idempotent;
   * cheap to call on every editor focus. `onProgress` (when provided)
   * receives a string for each meaningful step (download, verify,
   * extract). Resolves once every download has completed.
   */
  runSetup(pluginId: string, onProgress?: (msg: string) => void): Promise<void>;
  /** Fetch + parse the marketplace registry index (E10-01). */
  registryFetch(url: string): Promise<RegistryPlugin[]>;
  /** Fetch a plugin README (https only) for the marketplace detail pane. */
  registryReadme(url: string): Promise<string>;
}

/** One marketplace registry entry (E10-01). */
export interface RegistryPlugin {
  id: string;
  name: string;
  description?: string;
  publisher?: string;
  repo: { owner: string; repo: string; tag?: string };
  latest: string;
  readmeUrl?: string;
}

/**
 * LSP bridge — REQ-007. Mirrors the terminal bridge: opaque session ids,
 * id-filtered push channels for data/stderr/exit. Frames are exchanged
 * as base64-encoded byte blobs; the renderer's `lspClient` owns LSP
 * Content-Length framing.
 */
export interface HiveLspBridge {
  start(opts: {
    pluginId: string;
    language: string;
    defaultCwd?: string;
  }): Promise<{ sessionId: string; initializationOptions: unknown }>;
  /** `data` is base64-encoded — write a single framed LSP message. */
  write(sessionId: string, data: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  /** `data` arrives base64-encoded; reader is responsible for framing. */
  onData(sessionId: string, handler: (data: string) => void): Unsubscribe;
  onStderr(sessionId: string, handler: (data: string) => void): Unsubscribe;
  onExit(
    sessionId: string,
    handler: (exit: { code: number | null; signal: number | null }) => void,
  ): Unsubscribe;
}

/**
 * Extension-host bridge — E10-09 / E10-03. The renderer hands main the set of
 * enabled plugin ids; main activates each one's `main` entry in an isolated
 * utilityProcess (untrusted plugin JS never runs in the renderer or main). The
 * host registers the plugin's `contributes.commands` handlers, which the
 * renderer invokes by id.
 */
export interface HiveExtHostBridge {
  /** Declare the enabled plugins; returns the resulting host command ids. */
  setEnabled(ids: string[]): Promise<string[]>;
  /** Invoke a contributed command in the host, returning its result. */
  invoke(command: string, args?: unknown[]): Promise<unknown>;
  /** Subscribe to changes in the set of host-registered command ids. */
  onCommands(handler: (commands: string[]) => void): Unsubscribe;
}

/**
 * Git bridge — REQ-008. Each call takes the repo's absolute path; the
 * main process re-validates it (`.git/` must exist) before shelling out
 * to a real `git` subprocess.
 */
export interface HiveGitBridge {
  status(repoPath: string): Promise<import('../types/workspace').GitStatusSummary>;
  diff(repoPath: string, path: string, ref: 'index' | 'head'): Promise<string>;
  fileShow(repoPath: string, path: string, ref: 'index' | 'head' | string): Promise<string>;
  stage(repoPath: string, paths: string[]): Promise<void>;
  unstage(repoPath: string, paths: string[]): Promise<void>;
  discard(repoPath: string, paths: string[]): Promise<void>;
  commit(repoPath: string, message: string): Promise<void>;
  push(repoPath: string): Promise<{ ahead: number; behind: number; stdout: string }>;
  pull(repoPath: string): Promise<{ ahead: number; behind: number; stdout: string }>;
  branches(repoPath: string): Promise<{ current: string; local: string[]; remote: string[] }>;
  checkout(repoPath: string, branch: string, create?: boolean): Promise<void>;
  aheadBehind(repoPath: string): Promise<{ ahead: number; behind: number }>;
  /** Amend the last commit with a new message (E7-10). */
  commitAmend(repoPath: string, message: string): Promise<void>;
  /** Recent commits, newest first (E7-07). */
  log(repoPath: string, limit?: number): Promise<import('../types/workspace').GitLogEntry[]>;
  /** Per-line blame for a tracked file (E7-08). */
  blame(repoPath: string, path: string): Promise<import('../types/workspace').GitBlameLine[]>;
  /** Stash operations (E7-09). */
  stashList(repoPath: string): Promise<import('../types/workspace').GitStashEntry[]>;
  stashPush(repoPath: string, message?: string): Promise<void>;
  stashApply(repoPath: string, ref: string): Promise<void>;
  stashPop(repoPath: string, ref: string): Promise<void>;
  stashDrop(repoPath: string, ref: string): Promise<void>;
  /** Apply a unified-diff patch to the index (hunk staging, E7-02). */
  applyPatch(
    repoPath: string,
    patch: string,
    opts?: { reverse?: boolean; cached?: boolean },
  ): Promise<void>;
}

export interface HiveBridge {
  /** `process.platform` in the main process (resolved once at preload time). */
  platform: NodeJS.Platform;
  fs: HiveFsBridge;
  project: HiveProjectBridge;
  state: HiveStateBridge;
  settings: HiveSettingsBridge;
  search: HiveSearchBridge;
  debug: HiveDebugBridge;
  shell: HiveShellBridge;
  terminal: HiveTerminalBridge;
  plugins: HivePluginsBridge;
  lsp: HiveLspBridge;
  exthost: HiveExtHostBridge;
  git: HiveGitBridge;
  orchestration: HiveOrchestrationBridge;
  run: HiveRunBridge;
  workspace: HiveWorkspaceBridge;
  story: HiveStoryBridge;
  loop: HiveLoopBridge;
  questions: HiveQuestionsBridge;
  requirement: HiveRequirementBridge;
  repo: HiveRepoBridge;
  index: HiveIndexBridge;
  manager: HiveManagerBridge;
  /**
   * Subscribe to filesystem-change events emitted by the active project's
   * chokidar watcher. Returns an unsubscribe function.
   */
  onFsChange(handler: FsChangeHandler): Unsubscribe;
}
