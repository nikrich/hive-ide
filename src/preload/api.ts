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

// Terminal-session persisted shapes (schema v5) — imported from shared types
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
  /** Absolute path of the bound hive workspace, if any. */
  hiveWorkspacePath?: string;
  /** View that was foreground on close (schema v5). Absent → 'ide'. */
  activeView?: 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term';
  /** Whether the bottom panel was open (schema v5). Absent → true. */
  panelOpen?: boolean;
  /** Active bottom-panel tab (schema v5). Absent → 'log'. */
  panelTab?: 'terminal' | 'log' | 'problems';
  /** Bottom-panel terminal tabs (schema v5). Fresh shells on restore. */
  panelTerminals?: PanelTerminalTab[];
  /** Focused bottom-panel terminal tab id (schema v5), or null. */
  activePanelTerminalId?: string | null;
  /** Full-screen terminal sessions (schema v5). Fresh shells on restore. */
  termSessions?: TermSessionSnapshot[];
  /** Focused full-screen session id (schema v5), or null. */
  activeTermSessionId?: string | null;
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
  schemaVersion: 5;
  lastProjectId: string | null;
  recents: RecentEntry[];
  projects: Record<string, ProjectSession>;
  layout: LayoutSnapshot;
  /**
   * Per-workspace plugin enable state, keyed by `Project.id`. REQ-006.
   */
  enabledPlugins: Record<string, string[]>;
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
  contributes?: {
    languages?: PluginLanguageContribution[];
    languageServers?: PluginLanguageServerContribution[];
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

export interface HiveShellBridge {
  openExternal(url: string): Promise<void>;
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
}

export interface HiveBridge {
  /** `process.platform` in the main process (resolved once at preload time). */
  platform: NodeJS.Platform;
  fs: HiveFsBridge;
  project: HiveProjectBridge;
  state: HiveStateBridge;
  shell: HiveShellBridge;
  terminal: HiveTerminalBridge;
  plugins: HivePluginsBridge;
  lsp: HiveLspBridge;
  git: HiveGitBridge;
  orchestration: HiveOrchestrationBridge;
  /**
   * Subscribe to filesystem-change events emitted by the active project's
   * chokidar watcher. Returns an unsubscribe function.
   */
  onFsChange(handler: FsChangeHandler): Unsubscribe;
}
