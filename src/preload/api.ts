// src/preload/api.ts
//
// The renderer ↔ main contract. This file is the single source of truth for
// the shape of `window.hive`. Every later main-process story implements one
// slice of `HiveBridge`; every renderer story imports types from here.
//
// Types that describe the workspace domain (Project / Repo / PersistedState /
// etc.) are declared inline here for STORY-015. STORY-016 (Main: project
// detection + shared types) introduces `src/types/workspace.ts` and may move
// these definitions there — at that point this file will re-export them so
// the rest of the codebase keeps importing from one place.

// ---------------------------------------------------------------------------
// Workspace domain types
// ---------------------------------------------------------------------------

export type ProjectSource = 'hive' | 'auto-detected' | 'single-repo' | 'empty';

export interface Repo {
  /** Hive team name when source === 'hive', otherwise `basename(path)`. */
  name: string;
  /** Absolute path. */
  path: string;
  /** Whether the directory contains a `.git/` subdirectory. */
  isGitRepo: boolean;
}

export interface Project {
  /** Stable across renames-by-path: `sha1(rootPath)`. */
  id: string;
  /** `basename(rootPath)`, user-overridable later. */
  name: string;
  /** Absolute path. */
  rootPath: string;
  source: ProjectSource;
  repos: Repo[];
  /** Unix milliseconds. */
  lastOpenedAt: number;
}

export interface RecentEntry {
  id: string;
  name: string;
  rootPath: string;
  source: ProjectSource;
  repoCount: number;
  lastOpenedAt: number;
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
  rootPath: string;
  name: string;
  source: ProjectSource;
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

export interface PersistedState {
  schemaVersion: 1;
  lastProjectId: string | null;
  recents: RecentEntry[];
  projects: Record<string, ProjectSession>;
  window: WindowBounds;
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
  detect(path: string): Promise<Project>;
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

export interface HiveBridge {
  /** `process.platform` in the main process (resolved once at preload time). */
  platform: NodeJS.Platform;
  fs: HiveFsBridge;
  project: HiveProjectBridge;
  state: HiveStateBridge;
  shell: HiveShellBridge;
  /**
   * Subscribe to filesystem-change events emitted by the active project's
   * chokidar watcher. Returns an unsubscribe function.
   */
  onFsChange(handler: FsChangeHandler): Unsubscribe;
}
