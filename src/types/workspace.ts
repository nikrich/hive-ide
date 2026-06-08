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
  /** Absolute path of the hive workspace bound to this project, if any. */
  hiveWorkspacePath?: string;
}

// ---------------------------------------------------------------------------
// Terminal persistence (renamable terminals + session restore)
// ---------------------------------------------------------------------------

/** Split direction for a full-screen terminal pane tree. */
export type SplitDir = 'row' | 'col'

/**
 * A leaf (one terminal) or a binary split of two child nodes. Pure data —
 * safe to persist. Relocated here from `renderer/src/lib/paneTree.ts` so the
 * persisted `TermSessionSnapshot` can reference it from shared types.
 */
export type PaneNode =
  | { type: 'pane'; id: string }
  | {
      type: 'split'
      id: string
      dir: SplitDir
      sizes: [number, number]
      a: PaneNode
      b: PaneNode
    }

/** One bottom-panel terminal tab (no live xterm/pty handle). */
export interface PanelTerminalTab {
  tabId: string
  title: string
  cwd?: string
}

/** Per-pane metadata for a persisted full-screen session. */
export interface TermPaneMeta {
  title: string
  cwd?: string
  branch: string
}

/** One full-screen terminal session — serializable layout only. */
export interface TermSessionSnapshot {
  id: string
  group: string
  title: string
  branch: string
  root: PaneNode
  activePane: string
  panes: Record<string, TermPaneMeta>
}

/** Workspace-global terminal state (shared across projects, persisted once). */
export interface TerminalsSnapshot {
  panelTerminals: PanelTerminalTab[]
  activePanelTerminalId: string | null
  termSessions: TermSessionSnapshot[]
  activeTermSessionId: string | null
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
  /** Secondary (split) group tabs (E5-09). */
  secondaryTabs?: Array<{ path: string; viewState: unknown | null }>;
  /** Active tab in the secondary group (E5-09). */
  secondaryActiveTabPath?: string | null;
  /** Absolute path of the bound hive workspace, if any. */
  hiveWorkspacePath?: string;
  /** View that was foreground on close. Absent → 'ide'. */
  activeView?: 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term'
  /** Whether the bottom panel was open. Absent → true. */
  panelOpen?: boolean
  /** Active bottom-panel tab. Absent → 'log'. */
  panelTab?: 'terminal' | 'log' | 'problems'
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
 * REQ-009 bumps from 4 → 5 to persist active view, bottom-panel state, and terminal tabs/sessions; v4 → v5 is shape-preserving (the new fields live inside the optional ProjectSession block).
 * REQ-010 bumps from 5 → 6 to move terminal state from per-project to a
 * workspace-global `terminals` field. The four terminal fields
 * (`panelTerminals`, `activePanelTerminalId`, `termSessions`,
 * `activeTermSessionId`) leave `ProjectSession` and live once at the top
 * level so terminal sessions are shared across projects and survive project
 * swaps. v5 → v6 hoists the last project's terminal state into the new
 * global slot, then strips the per-project copies.
 */
export interface PersistedState {
  schemaVersion: 6;
  /** Project to reopen on next launch, or `null` for Welcome. */
  lastProjectId: string | null;
  /** Recents list, LRU-ordered by `lastOpenedAt` descending, max 10. */
  recents: RecentEntry[];
  /** Per-project session state, keyed by `Project.id`. */
  projects: Record<string, ProjectSession>;
  /** Workspace-level IDE layout (panel sizes). REQ-005. */
  layout: LayoutSnapshot;
  /** Workspace-global terminal state (shared across projects). REQ-010. */
  terminals: TerminalsSnapshot;
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
  /**
   * Stable id used in the tab list. For file tabs this is the file's
   * absolute path; for diff tabs it's a synthetic key like
   * `diff:<ref>:<absPath>` (the renderer's SourceControlView constructs
   * it). The tab kind is inferred from `diffMeta`.
   */
  path: string;
  /** Monaco view state captured on last tab-blur. `null` until first capture. */
  viewState: EditorViewState | null;
  /** True when in-memory content differs from disk. */
  dirty: boolean;
  /**
   * Preview tab (E5-04): opened by a single click, rendered italic, and
   * reused for the next single-click open. Pinned (cleared) on edit or
   * double-click. At most one preview tab exists per group.
   */
  preview?: boolean;
  /**
   * When present, this tab renders a Monaco DiffEditor instead of a
   * normal editor — REQ-008's diff view. The renderer fetches the two
   * sides on demand from the store / git bridge.
   */
  diffMeta?: {
    /** Absolute path of the repo containing `path`. */
    repoPath: string;
    /** Repo-relative path of the file. */
    path: string;
    /**
     * Which two sides to show:
     *   - 'head'  → original = HEAD, modified = working tree (Working Tree view).
     *   - 'index' → original = HEAD, modified = index (Staged view).
     */
    ref: 'index' | 'head';
    /** Human-readable label rendered as the tab title. */
    label: string;
  };
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
  /** Secondary (split) group tabs, restored on load (E5-09). */
  secondaryTabs?: OpenTab[];
  /** Active tab path in the secondary group (E5-09). */
  secondaryActiveTabPath?: string | null;
  /** View that was foreground on close. Absent → 'ide'. */
  activeView?: 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term'
  /** Whether the bottom panel was open. Absent → true. */
  panelOpen?: boolean
  /** Active bottom-panel tab. Absent → 'log'. */
  panelTab?: 'terminal' | 'log' | 'problems'
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
 * REQ-007 added `contributes.languageServers` consumption (lazy spawn on
 * first matching-language file open) and `setup.downloads` (one-time
 * file-fetch step run on plugin enable, used by e.g. the Java plugin to
 * pull jdtls on first run).
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
    /** Default keybindings the plugin contributes (E10-04). */
    keybindings?: PluginKeybindingContribution[];
    /** Debug adapters the plugin contributes (E3-12 / E10-06). */
    debuggers?: PluginDebuggerContribution[];
    /** Settings the plugin contributes (E10-05). */
    configuration?: PluginConfigurationContribution;
    /** Colour themes the plugin contributes (E10-07 / E8-04). */
    themes?: PluginThemeContribution[];
  };
  /**
   * One-time setup steps run on plugin enable — currently only file
   * downloads (REQ-007). Idempotent: a step is skipped if its target
   * already exists on disk under the plugin folder.
   */
  setup?: {
    downloads?: PluginSetupDownload[];
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
 * Declarative language-server contribution — REQ-007.
 *
 * Tells the LSP runtime how to spawn a server process for `language` the
 * first time a file of that language is opened in a project where the
 * plugin is enabled. One process per (plugin, language) pair, shared by
 * every open file of the language and disposed when the plugin is
 * disabled, the project closes, or the IDE quits.
 *
 * The `command` template is expanded main-side: the literal substring
 * `${pluginDir}` is replaced with the plugin's absolute install path.
 * The expansion is checked to stay inside the plugins root so a
 * `${pluginDir}/../foo` can't escape. Plugin authors are responsible for
 * shipping a launcher script in their plugin folder (e.g. `launch.sh`).
 *
 * `initializationOptions` is sent verbatim as part of the LSP
 * `initialize` request — jdtls reads JVM args + workspace data dir from
 * here, for example. Treated as opaque JSON; main never inspects it.
 */
/** A keybinding a plugin contributes (E10-04). */
export interface PluginKeybindingContribution {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

/** A single setting a plugin contributes (E10-05). */
export interface PluginConfigProperty {
  type: 'boolean' | 'number' | 'string' | 'string[]';
  default: unknown;
  description?: string;
  /** Allowed values for a select-style string setting. */
  enum?: string[];
}

/** A plugin's contributed settings, keyed by dotted setting id (E10-05). */
export interface PluginConfigurationContribution {
  /** Section title shown in the settings editor. */
  title?: string;
  properties: Record<string, PluginConfigProperty>;
}

/** A colour theme a plugin contributes (E10-07 / E8-04). */
export interface PluginThemeContribution {
  id: string;
  label: string;
  type: 'dark' | 'light' | 'hc';
  /** Monaco color-map overrides (editor.background, etc.). */
  colors?: Record<string, string>;
}

/** A debug adapter a plugin contributes (E3-12 / E10-06). */
export interface PluginDebuggerContribution {
  /** Debug `type` matched against a launch config's `type`. */
  type: string;
  /** Human label. */
  label?: string;
  /** Adapter entry program (resolved relative to the plugin dir). */
  program: string;
  /** Runtime to launch `program` with, e.g. `node`. Default: spawn directly. */
  runtime?: string;
}

export interface PluginLanguageServerContribution {
  /** Language id the server speaks. Must match a contributes.languages id. */
  language: string;
  /**
   * Command to launch. The literal substring `${pluginDir}` is expanded
   * to the plugin's absolute install path before spawn.
   */
  command: string;
  args?: string[];
  /** Currently only 'stdio' is supported. 'socket' is reserved for v2. */
  transport?: 'stdio' | 'socket';
  /**
   * Passed verbatim as `initializationOptions` in the LSP `initialize`
   * request. Used by jdtls to configure JVM args, workspace data dir,
   * compiler options, etc.
   */
  initializationOptions?: unknown;
  /**
   * Optional working directory for the server process. `${pluginDir}`
   * expansion supported. Defaults to the active project's first repo
   * path (resolved renderer-side at start time; main treats it as a
   * caller-supplied string).
   */
  cwd?: string;
  /** Extra env vars (literal values; no expansion). Merged with process.env. */
  env?: Record<string, string>;
}

/**
 * One file-download step the IDE runs once before the plugin's language
 * server can start — REQ-007. Used to fetch large external binaries that
 * shouldn't be bundled inside the plugin tarball (e.g. jdtls's ~80 MB
 * release archive).
 *
 * `extractTo` is interpreted relative to the plugin's install folder;
 * paths that try to escape via `..` are rejected. `archive: 'none'`
 * saves the response verbatim without extracting — useful for shipping
 * a single binary.
 */
export interface PluginSetupDownload {
  /** Source URL. Must be https. */
  url: string;
  /**
   * Path relative to the plugin folder where the file (or extracted
   * archive contents) should land. Created if missing.
   */
  extractTo: string;
  /**
   * Optional sha256 of the downloaded archive. Verified before extract.
   * Strongly recommended.
   */
  sha256?: string;
  /**
   * 'tar.gz' or 'zip' — defaults to inferring from url. 'none' saves the
   * file verbatim without extracting.
   */
  archive?: 'tar.gz' | 'zip' | 'none';
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

// ---------------------------------------------------------------------------
// REQ-008 — Source control (git)
// ---------------------------------------------------------------------------

/**
 * One status entry emitted by `git:status` — derived from a single record
 * of `git status --porcelain=v2 -z`. The renderer groups these by
 * `staged` / `workingTree` / `conflicted` and renders them under repo
 * headers in the Source Control panel.
 *
 * Notes:
 * - For tracked-file modifications, `staged` and `workingTree` may BOTH be
 *   true — that file has been partially staged. The Source Control view
 *   shows two rows for that path: one in Staged Changes, one in Changes.
 * - For renames (state='renamed') `oldPath` is the index/HEAD path and
 *   `path` is the new working-tree path. Both are repo-relative with
 *   forward slashes.
 * - For untracked files, only `workingTree=true` is set (staged=false,
 *   state='untracked').
 * - For conflicts (`u` record), `state='conflicted'` and both `staged` and
 *   `workingTree` are true — every conflict touches both stages.
 */
export interface GitStatusEntry {
  /** Repo-relative path with forward slashes. */
  path: string;
  /** Previous repo-relative path for renames (state='renamed'). */
  oldPath?: string;
  state: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
  workingTree: boolean;
}

/**
 * Combined output of `git status --porcelain=v2 --branch -z`: the changed
 * entries plus the current branch + ahead/behind, all from one invocation.
 * `fetchScm` uses this so it needs a single git subprocess per repo.
 */
export interface GitStatusSummary {
  entries: GitStatusEntry[];
  /** Current branch, or `null` when detached HEAD. */
  branch: string | null;
  ahead: number;
  behind: number;
}

/** One commit in the log view (E7-07). */
export interface GitLogEntry {
  /** Full 40-char SHA. */
  hash: string;
  /** Abbreviated SHA. */
  shortHash: string;
  authorName: string;
  authorEmail: string;
  /** Author time, unix ms. */
  authorDate: number;
  subject: string;
}

/** One blamed line (E7-08). */
export interface GitBlameLine {
  /** 1-based final line number. */
  line: number;
  hash: string;
  authorName: string;
  /** Author time, unix ms. */
  authorTime: number;
  summary: string;
}

/** One stash entry (E7-09). */
export interface GitStashEntry {
  /** Stash ref, e.g. `stash@{0}`. */
  ref: string;
  /** Description line. */
  message: string;
}
