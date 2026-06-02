/**
 * Shared workspace types — used by main, preload, and renderer.
 *
 * Imported via type-only imports across Electron's process boundary so
 * there is no runtime coupling between processes. This file MUST stay
 * type-only — no values, no side effects.
 *
 * Owned by STORY-021 for the subset the renderer Zustand store needs;
 * STORY-016 will extend with `DirEntry`, `Stat`, `PersistedState`, etc.
 */

/**
 * How a project was identified from disk:
 * - `hive`         — `<root>/.hive/config.yaml` parsed
 * - `auto-detected`— direct child dirs contain `.git/`
 * - `single-repo`  — `<root>/.git/` exists
 * - `empty`        — none of the above; an empty project shell
 */
export type ProjectSource = 'hive' | 'auto-detected' | 'single-repo' | 'empty'

/** A single repository inside a project (one top-level node in the explorer). */
export interface Repo {
  /** Display name — hive team name when available, else basename(path). */
  name: string
  /** Absolute path to the repo root. */
  path: string
  /** True when `<path>/.git/` exists. */
  isGitRepo: boolean
}

/** A project = one workspace root the user opened, possibly containing many repos. */
export interface Project {
  /** Stable id — sha1(rootPath). Survives across renames-by-path. */
  id: string
  /** Display name — basename(rootPath), user-overridable later. */
  name: string
  /** Absolute path to the project root. */
  rootPath: string
  /** Detection rule that produced this project. */
  source: ProjectSource
  /** Repos discovered inside the project. */
  repos: Repo[]
  /** Last time this project was opened. Unix ms. */
  lastOpenedAt: number
}

/** A row in the Welcome screen's "recents" list. */
export interface RecentEntry {
  id: string
  name: string
  rootPath: string
  source: ProjectSource
  repoCount: number
  lastOpenedAt: number
}

/**
 * Monaco editor view state — scroll position, cursor, selections, folds.
 *
 * Typed as `unknown` here so the store does NOT depend on the monaco-editor
 * package. STORY-023 (MonacoEditor component) casts to the concrete
 * `monaco.editor.ICodeEditorViewState` at the edge.
 */
export type EditorViewState = unknown

/** An open editor tab. */
export interface OpenTab {
  /** Absolute path of the file. */
  path: string
  /** Monaco view state captured on last tab-blur. `null` until first capture. */
  viewState: EditorViewState | null
  /** True when in-memory content differs from disk. */
  dirty: boolean
}

/**
 * Snapshot of a project session — what `state:get` returns from main on
 * cold boot, what `hydrateFromSession` consumes on the renderer side.
 *
 * Kept minimal for STORY-021. STORY-019 (persisted state) may extend.
 */
export interface ProjectSessionSnapshot {
  /** Folders the user had expanded in the explorer. Absolute paths. */
  expandedPaths: string[]
  /** Open tabs in left-to-right order. */
  openTabs: OpenTab[]
  /** Path of the currently focused tab, or `null` if none. */
  activeTabPath: string | null
}
