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
  schemaVersion: 4;
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
  /**
   * Subscribe to filesystem-change events emitted by the active project's
   * chokidar watcher. Returns an unsubscribe function.
   */
  onFsChange(handler: FsChangeHandler): Unsubscribe;
}
