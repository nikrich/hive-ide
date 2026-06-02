/**
 * Shared workspace types — imported by main, preload, and renderer.
 *
 * Type-only imports are erased at build time, so this module is safe to
 * import across Electron's process boundaries without runtime coupling.
 *
 * REQ-003 redirected the model from "Open Folder auto-detects a project"
 * to "user-created named projects that hold one-or-more user-added repos".
 * The `ProjectSource` enum and any notion of a single project `rootPath`
 * are gone — a project is just a named container with id + createdAt +
 * lastOpenedAt + repos[].
 */

/**
 * A repo inside a project — one collapsible top-level node in the explorer.
 */
export interface Repo {
  /** Default: `basename(path)`. */
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** True if `<path>/.git/` exists. Detected once when the repo is added. */
  isGitRepo: boolean;
}

/**
 * A project — a user-named container of repos.
 *
 * Projects are no longer "the folder you opened". They are user-created,
 * user-named, and start with `repos: []`. The user adds folders to a
 * project one at a time.
 */
export interface Project {
  /** `crypto.randomUUID()` assigned at creation time. */
  id: string;
  /** User-given, required, non-empty (trimmed). */
  name: string;
  /** Repos surfaced as top-level explorer roots. May be empty initially. */
  repos: Repo[];
  /** Creation timestamp, unix milliseconds. */
  createdAt: number;
  /** Last-opened timestamp, unix milliseconds. */
  lastOpenedAt: number;
}

/**
 * Lightweight project shape shown in the Welcome screen's recents list.
 */
export interface RecentEntry {
  id: string;
  name: string;
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
 *
 * After REQ-003 the persisted-session shape mirrors the new `Project`
 * shape: id + name + createdAt + lastOpenedAt + repos, plus the UX-state
 * fields the IDE restores on rehydration.
 */
export interface ProjectSession {
  id: string;
  name: string;
  repos: Repo[];
  createdAt: number;
  lastOpenedAt: number;
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
 *
 * REQ-003 bumps the version from 1 to 2. The migrator archives v1
 * payloads as `workspace.v1.bak` and starts fresh — there is no
 * shape-preserving upgrade path because the old "project = folder"
 * model can't be mapped onto the new "project = named container".
 */
export interface PersistedState {
  schemaVersion: 2;
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
 * preload.
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
 * (which also carries id / name / repos / timestamps). The Zustand store
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

/**
 * Result of `project:inspect-folder` — the bare facts about a folder the
 * user just picked. The renderer turns it into a `Repo` and either pins it
 * into a Project being created (new-project modal) or appends it to the
 * active project (Add Folder flow).
 */
export interface InspectedFolder {
  /** Absolute filesystem path. */
  path: string;
  /** `basename(path)`. */
  name: string;
  /** True if `<path>/.git/` exists. */
  isGitRepo: boolean;
}
