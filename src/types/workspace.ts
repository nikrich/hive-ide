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
 * Workspace-level layout snapshot — REQ-005.
 *
 * Pixel sizes of the three resizable IDE panels. Persisted at the workspace
 * level (one snapshot shared across all projects) rather than per-project:
 * users almost always want the same chrome layout regardless of which
 * project they're in.
 */
export interface LayoutSnapshot {
  /** Width of the file explorer column, in pixels. */
  explorerWidth: number;
  /** Width of the agent dock column, in pixels. */
  dockWidth: number;
  /** Height of the bottom panel row, in pixels. */
  panelHeight: number;
}

/**
 * The on-disk schema written to `workspace.json` by `electron-store`.
 *
 * `schemaVersion` is bumped explicitly whenever the shape changes;
 * the main-process migrator branches on it.
 *
 * REQ-003 bumped from 1 → 2 (project model rewrite — archive + reset).
 * REQ-005 bumped from 2 → 3 to add the `layout` field; the v2 → v3
 * migration is shape-preserving (carry everything, fill `layout` with
 * defaults).
 * REQ-006 bumps from 3 → 4 to add `enabledPlugins` — the per-project
 * record of which installed plugins are enabled. v3 → v4 is also
 * shape-preserving (carry everything, fill `enabledPlugins` with `{}`).
 */
export interface PersistedState {
  schemaVersion: 4;
  /** Project to reopen on next launch, or `null` for Welcome. */
  lastProjectId: string | null;
  /** Recents list, LRU-ordered by `lastOpenedAt` descending, max 10. */
  recents: RecentEntry[];
  /** Per-project session state, keyed by `Project.id`. */
  projects: Record<string, ProjectSession>;
  /** Workspace-level IDE layout (panel sizes). REQ-005. */
  layout: LayoutSnapshot;
  /**
   * Per-workspace plugin enable state, keyed by `Project.id`. The value
   * for each project is the list of plugin ids that are enabled while
   * that project is active. REQ-006.
   */
  enabledPlugins: Record<string, string[]>;
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

// ---------------------------------------------------------------------------
// REQ-006 — plugin runtime
// ---------------------------------------------------------------------------

/**
 * Manifest published by a plugin in its `plugin.json` file. The manifest
 * is read by the main process at plugin discovery time and validated
 * against the rules in `src/main/plugins/loader.ts` (id pattern, semver,
 * engine range, etc.).
 *
 * `contributes.languageServers` is parsed but unused in REQ-006 — REQ-007
 * adds the LSP runner that consumes it.
 */
export interface PluginManifest {
  /** `<publisher>/<name>` slug. Matches `/^[a-z0-9-]+\/[a-z0-9-]+$/i`. */
  id: string;
  /** Display name shown in the Plugins view. */
  name: string;
  /** Plugin version. Must be valid semver. */
  version: string;
  description?: string;
  publisher?: string;
  /** Semver-range engine constraints the host must satisfy. */
  engines?: { hive?: string };
  /** Declarative contributions registered with Monaco at activation. */
  contributes?: {
    languages?: PluginLanguageContribution[];
    languageServers?: PluginLanguageServerContribution[];
  };
}

/**
 * One language contribution — a single language id that the plugin
 * registers, optionally with a Monaco LanguageConfiguration and a Monarch
 * grammar. Both paths are resolved relative to the plugin's folder; the
 * main process serves their contents via `plugins:read-asset` so the
 * renderer never touches the filesystem directly.
 */
export interface PluginLanguageContribution {
  id: string;
  extensions?: string[];
  aliases?: string[];
  /** Path relative to the plugin folder. JSON `LanguageConfiguration`. */
  configuration?: string;
  /** Path relative to the plugin folder. JSON `MonarchLanguage`. */
  grammar?: string;
}

/**
 * Declarative language-server contribution. Parsed but not acted on in
 * REQ-006 — REQ-007 wires `command` + `args` + `transport` into the LSP
 * runner. Kept on the manifest now so example plugins can already declare
 * one without needing a v5 bump later.
 */
export interface PluginLanguageServerContribution {
  language: string;
  command: string;
  args?: string[];
  transport?: 'stdio' | 'socket';
}

/**
 * A plugin discovered on disk, with the result of validation.
 *
 * `valid=true` means the manifest parsed, ids and semver matched, and the
 * engine range (if any) is satisfied by the running host. `valid=false`
 * means the plugin will *not* be activated — `invalidReason` carries a
 * human-readable string the Plugins view can show.
 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute path to the plugin's root folder. */
  rootPath: string;
  /** True if the manifest validated and engine range matches. */
  valid: boolean;
  /** Human-readable reason when `valid=false`. */
  invalidReason?: string;
}

/**
 * Per-project record of an installed plugin. Used in the persisted
 * `enabledPlugins[projectId]` array to remember the user's enable/disable
 * choice across sessions.
 */
export interface InstalledPluginRecord {
  id: string;
  enabled: boolean;
}
