/**
 * Shared workspace types — imported by main, preload, and renderer.
 *
 * Type-only imports are erased at build time, so this module is safe to
 * import across Electron's process boundaries without runtime coupling.
 *
 * Defined by REQ-002 design doc, STORY-016.
 */

/**
 * How a project was determined to be a project.
 *
 * - `hive`           — `<root>/.hive/config.yaml` exists; repos come from
 *                      its `teams[]`.
 * - `auto-detected`  — at least one direct child of `<root>` contains
 *                      `.git/`; repos are those children.
 * - `single-repo`    — `<root>/.git/` exists; the single repo *is* the root.
 * - `empty`          — none of the above; `repos` is empty.
 */
export type ProjectSource = 'hive' | 'auto-detected' | 'single-repo' | 'empty';

/**
 * A repo inside a project — one collapsible top-level node in the explorer.
 */
export interface Repo {
  /** Hive team name (from `.hive/config.yaml`) or `basename(path)` otherwise. */
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** True if `<path>/.git/` exists. */
  isGitRepo: boolean;
}

/**
 * A project — the user's open folder, plus the repos detected inside it.
 */
export interface Project {
  /** `sha1(rootPath)` — stable identifier across renames-by-path. */
  id: string;
  /** `basename(rootPath)`; user-overridable in a future REQ. */
  name: string;
  /** Absolute filesystem path of the project root. */
  rootPath: string;
  /** How this project was detected — see {@link ProjectSource}. */
  source: ProjectSource;
  /** Repos surfaced as top-level explorer roots. */
  repos: Repo[];
  /** Last-opened timestamp, unix milliseconds. */
  lastOpenedAt: number;
}

/**
 * Lightweight project shape shown in the Welcome screen's recents list.
 *
 * Avoids round-tripping the full repo list when all we need is a card.
 */
export interface RecentEntry {
  id: string;
  name: string;
  rootPath: string;
  source: ProjectSource;
  repoCount: number;
  lastOpenedAt: number;
}

/**
 * One entry returned by `fs:list-dir`.
 */
export interface DirEntry {
  name: string;
  /** Absolute path of the entry. */
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Modification time, unix milliseconds. */
  mtime: number;
}

/**
 * Lightweight stat record returned by `fs:stat`.
 */
export interface Stat {
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  /** Modification time, unix milliseconds. */
  mtime: number;
  /** Status-change time, unix milliseconds. */
  ctime: number;
}

/**
 * Per-project session state — the bits needed to feel like the IDE
 * never closed.
 *
 * `viewState` is Monaco's `ICodeEditorViewState` serialised as a plain
 * JSON object; typed as `unknown` here so the shared types don't pull
 * Monaco into the main process. The renderer casts it back when handing
 * it to `monaco.editor.IStandaloneCodeEditor#restoreViewState`.
 */
export interface ProjectSession {
  id: string;
  rootPath: string;
  name: string;
  source: ProjectSource;
  /** Absolute folder paths the user had expanded. */
  expandedPaths: string[];
  openTabs: Array<{
    /** Absolute file path. */
    path: string;
    /** Monaco view state (scroll + cursor + folds) or `null`. */
    viewState: unknown | null;
  }>;
  /** Absolute path of the tab that was focused, or `null`. */
  activeTabPath: string | null;
}

/**
 * The on-disk schema written to `workspace.json` by `electron-store`.
 *
 * `schemaVersion` is bumped explicitly whenever the shape changes;
 * the main-process migrator branches on it.
 */
export interface PersistedState {
  schemaVersion: 1;
  /** Project to reopen on next launch, or `null` for Welcome. */
  lastProjectId: string | null;
  /** Recents list, LRU-ordered by `lastOpenedAt` descending, max 10. */
  recents: RecentEntry[];
  /** Per-project session state, keyed by `Project.id`. */
  projects: Record<string, ProjectSession>;
  /** Last window bounds for window-restore. */
  window: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
}

/**
 * Opaque placeholder for Monaco's `ICodeEditorViewState`. Kept as `unknown` in
 * shared types so the renderer doesn't drag the Monaco type tree into main /
 * preload. STORY-023 (MonacoEditor component) casts to the concrete
 * `monaco.editor.ICodeEditorViewState` at the edge.
 */
export type EditorViewState = unknown;

/** An open editor tab. */
export interface OpenTab {
  /** Absolute path of the file. */
  path: string;
  /** Monaco view state captured on last tab-blur. `null` until first capture. */
  viewState: EditorViewState | null;
  /** True when in-memory content differs from disk. */
  dirty: boolean;
}

/**
 * Per-project session state restored on relaunch — separate from `ProjectSession`
 * (which also carries id / rootPath / name / source). The Zustand store
 * hydrates from a snapshot, then the persistence layer wraps it back into a
 * `ProjectSession` for `electron-store`.
 */
export interface ProjectSessionSnapshot {
  /** Folders the user had expanded in the explorer. Absolute paths. */
  expandedPaths: string[];
  /** Open tabs in left-to-right order. */
  openTabs: OpenTab[];
  /** Path of the currently focused tab, or `null` if none. */
  activeTabPath: string | null;
}
