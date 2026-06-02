# REQ-002 — Real files + editor

_Design doc · brainstormed 2026-06-02 · approved by user · queued to hive v2 as REQ-002._

## Goal

Move the Hive IDE from a beautiful prototype (everything seeded from `data/seed.ts`) to a **usable code editor**: real folders, real files, real edits, real saves. Monaco replaces the textarea editor. Multi-repo projects are first-class. The IDE stops being a mock and starts being something you can ship work with.

## Scope decisions

These were locked during the 2026-06-02 brainstorm.

| Decision | Choice |
|---|---|
| Editor smarts | Monaco with **built-in TS/JS language services** (autocomplete + diagnostics for `.ts/.tsx/.js/.jsx` for free). No LSP for other languages this REQ. |
| Multi-repo layout | **VSCode-style multi-root tree** — every repo in the active project shows as a collapsible top-level node. |
| Project structure | **Auto-detect** from the chosen folder — no manifest required. |
| File operations | **Standard CRUD** — open · save · new file · new folder · rename · delete (to trash) · refresh. |
| Session restore | **Last project + open tabs + active tab + cursor + scroll** — feels like the IDE never closed. |
| Architecture | **Big-bang rewrite** — rip out `FILE_CONTENTS` / `tree` / `openTabs` / agent-streaming from seed.ts, build real services + Monaco editor + Welcome wired together in one REQ. No interface-layer abstraction for hypothetical future flexibility. |

## In scope

- Real filesystem (chokidar watcher, IPC for read / write / list / mkdir / rename / trash / stat / exists / reveal-in-finder)
- Monaco editor with TS/JS smarts
- Multi-root explorer (all repos visible as top-level roots, lazy directory loading)
- Project detection (4 rules in order — see below)
- Welcome screen (repurposed `ProjectsHub.tsx` showing real recents from disk)
- Persistence (`electron-store`, schema v1, full session restore)
- File-op context menu + keyboard shortcuts (⌘N · ⌘⇧N · Enter to rename · ⌫ to delete · ⌘R refresh · ⌘O open folder · ⌘P quick-open · ⌘S save)
- External-change banner when an open dirty file is modified on disk
- Tab labels: `repo / relative-path` when multiple repos have files open; bare filename otherwise

## Out of scope (deferred to future REQs)

- LSP for non-TS/JS languages
- Git markers (`M` / `A` / `U`) in the tree
- Source-control panel (stage / commit / diff)
- Project-wide find / replace (⌘⇧F)
- Side-by-side diff view (the "Compare" button in the watcher banner is rendered disabled with a tooltip pointing at the future REQ)
- Per-project `tsconfig.json` loaded into Monaco
- Customised Monaco theme
- Real Hive integration — dock + bottom panel + PRsView stay on seed data
- Real terminal (BottomPanel keeps mock)
- Cross-platform packaging (Windows + Linux smoke testing comes later)

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  MAIN PROCESS                          src/main/                 │
│  • Open Folder dialog (showOpenDialog)                           │
│  • Filesystem IPC: read/write/list/mkdir/rename/trash/stat/...   │
│  • Project detection (.hive/config.yaml → .git/ scan → fallback) │
│  • chokidar watcher per active project, 100ms debounce           │
│  • Persisted state via electron-store                            │
└──────────────────────────────────────────────────────────────────┘
                              │ IPC: invoke/handle + event channels
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  PRELOAD                               src/preload/              │
│  contextBridge → window.hive.{                                   │
│    platform, fs:{...}, project:{...}, state:{...},               │
│    shell:{...}, onFsChange(handler): () => void                  │
│  }                                                               │
└──────────────────────────────────────────────────────────────────┘
                              │ awaited promises + EventEmitter
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  RENDERER                              src/renderer/src/         │
│                                                                  │
│  store/workspaceStore.ts   ←  Zustand: project, repos, tabs,     │
│                                dirty map, contents cache,        │
│                                viewStates, expanded folders      │
│                                                                  │
│  components/Explorer.tsx   ←  rewired: multi-root from store     │
│  components/MonacoEditor   ←  NEW: replaces textarea + highlight │
│  components/Editor.tsx     ←  tabs + breadcrumb + Monaco mount   │
│  components/ProjectsHub.tsx ←  doubles as Welcome (real recents) │
│  App.tsx                   ←  routes Welcome ↔ IDE on project    │
│                                                                  │
│  data/seed.ts              ←  KEPT for roster / board / log /    │
│                                problems / prs / ROLE              │
│                              REMOVED: FILE_CONTENTS, tree,       │
│                                openTabs, AGENT_FILE, AGENT_INCOMING
└──────────────────────────────────────────────────────────────────┘
```

Key choices:

- **Zustand** (~3 kB) for renderer state — lighter than Context + useReducer, easier to test.
- **`@monaco-editor/react`** dynamic import — the ~5 MB Monaco bundle doesn't block the Welcome screen.
- **chokidar** in main, debounced 100 ms, one watcher per active project.
- **`electron-store`** persists state to platform-conventional locations (Mac: `~/Library/Application Support/Hive IDE/workspace.json`).
- **Mocked panels** (Dock, BottomPanel, PRsView) keep their seed data, get a subtle "mock data — Hive not connected" ribbon to set expectations.

## Project + Repo model

### Types

Shared types live in `src/types/workspace.ts` at the repo root — imported by main, preload, and renderer alike. Type-only imports are erased at build time so there's no runtime coupling across Electron's process boundaries.

```ts
// src/types/workspace.ts
type ProjectSource = 'hive' | 'auto-detected' | 'single-repo' | 'empty';

interface Project {
  id: string;              // sha1(rootPath) — stable across renames-by-path
  name: string;            // basename(rootPath), user-overridable later
  rootPath: string;        // absolute
  source: ProjectSource;
  repos: Repo[];
  lastOpenedAt: number;    // unix ms
}

interface Repo {
  name: string;            // hive team name, or basename(path)
  path: string;            // absolute
  isGitRepo: boolean;      // has .git/
}

interface RecentEntry {
  id: string;
  name: string;
  rootPath: string;
  source: ProjectSource;
  repoCount: number;
  lastOpenedAt: number;
}
```

### Detection rules — main process applies in order

```
1. <root>/.hive/config.yaml exists
   → parse YAML, repos = teams.map(t => ({
       name: t.name,
       path: resolve(root, t.repo_path),
       isGitRepo: hasGit(resolve(root, t.repo_path))
     }))
   → source = 'hive'

2. else any direct child has .git/
   → repos = git-children.map(c => ({
       name: basename(c),
       path: c,
       isGitRepo: true
     }))
   → source = 'auto-detected'

3. else <root>/.git/ exists
   → repos = [{
       name: basename(root),
       path: root,
       isGitRepo: true
     }]
   → source = 'single-repo'

4. else
   → repos = []
   → source = 'empty'   (UI shows "no repos found — Add Folder")
```

### Welcome flow

Reuses **`ProjectsHub.tsx`** — no separate Welcome component.

- **No project active** → workarea renders the hub. Seeded `acme/*` cards replaced with persisted recents (max 10, LRU by `lastOpenedAt`). Large `Open Folder…` button (⌘O) above the grid.
- **Project active** → hub reachable via the activity rail. Recents list shown, current project marked "● currently open" (already supported).
- **First launch** → empty recents, just the CTA + one-line hint: "Open any folder — repos auto-detected".

Recent-card content (reuses `.pcard`):

```
┌─ acme ──────────────────── source-chip ─┐
│ 3 repos · TypeScript · Go               │
│ ─────────────────────────────────────── │
│ ~/code/acme                2 hours ago  │
└─────────────────────────────────────────┘
```

The **source-chip** displays `hive` / `auto-detected` / `single-repo` / `empty` so users see *why* the IDE grouped the repos that way.

The title-bar **project switcher** drops down the same recents list + `Open Folder…`.

## Editor surface

### MonacoEditor — new component

```ts
// src/renderer/src/components/MonacoEditor.tsx
interface MonacoEditorProps {
  path: string;            // absolute — drives language detection
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;      // bound to ⌘S inside Monaco
  viewState?: monaco.editor.ICodeEditorViewState;
  onViewStateChange?: (s: monaco.editor.ICodeEditorViewState) => void;
}
```

- Theme `vs-dark` (custom theming deferred)
- Language map (`src/renderer/src/lib/languageForPath.ts`): `.ts/.tsx → typescript`, `.js/.jsx → javascript`, `.json → json`, `.css → css`, `.md → markdown`, default `plaintext`
- Monaco TS defaults: target `ESNext`, `jsx: ReactJSX`, `strict: true`. Per-project tsconfig loading is **out of scope**.
- Loaded via dynamic import so Monaco's bundle doesn't block Welcome
- `viewState` (scroll + cursor + folds) saved into store on tab change, restored on tab return — that's how session restore picks up cursor positions

### Editor.tsx rewrite

- Keeps `TabBar`, `Breadcrumb`, `EmptyEditor` markup
- **Removes** `CodeEditor` (textarea + highlight.js) and `AgentEditor` (read-only streaming view)
- Tab list, active tab, dirty flags all come from the Zustand store — no props from App
- Tab labels: `repo / relative-path` when multiple repos are open; bare filename otherwise. Long paths truncate with mid-ellipsis. Full absolute path in `title=`.
- Tab close button + dirty dot behave as today

### Explorer.tsx rewrite (multi-root)

- Top-level nodes = `project.repos` (one per repo)
- Each repo expandable independently
- **Lazy directory loading** — fetching a directory's children is an IPC round-trip; cached per absolute path in the store. Reduces cold-load cost on huge repos.
- `expandedSet: Set<absolutePath>` persisted across relaunch
- Selected node tracked in store (matches existing `activePath`)
- **No git markers** — the chip slot is empty until the git REQ

### File operations

| Action | Trigger | Behaviour |
|---|---|---|
| Open | Click file, ⌘P quick-open | `fs:read-file` → cache in store → open tab → focus |
| Save | ⌘S | `fs:write-file` → clear dirty |
| New File | Context menu, ⌘N | Inline input under selected folder; ESC cancels, Enter creates + opens |
| New Folder | Context menu, ⌘⇧N | Inline input; Enter creates |
| Rename | Context menu, Enter on selected file | Inline input replaces the row; updates open tabs if renamed file is open |
| Delete | Context menu, ⌫ on selected | `shell.trashItem()`; confirms if file is dirty; closes open tab |
| Refresh | Context menu, ⌘R on tree | Re-fetches current node's children |
| Reveal in Finder | Context menu | `shell.showItemInFolder()` |
| Copy Path | Context menu | absolute path → clipboard |

### External-change handling (chokidar in main → renderer)

- **Open + clean + changed on disk** → silently reload contents, preserve viewState
- **Open + dirty + changed on disk** → banner across the editor: "**This file changed on disk.** [Reload] [Keep yours] [Compare (disabled — coming in git REQ)]"
- **Open + deleted externally** → close tab, toast: "`<path>` was deleted on disk"
- **Tree-level add / remove** → refresh affected parent's listing

## Persistence + IPC

### On-disk state

```
macOS:  ~/Library/Application Support/Hive IDE/workspace.json
Win:    %APPDATA%/Hive IDE/workspace.json
Linux:  ~/.config/Hive IDE/workspace.json
```

```ts
interface PersistedState {
  schemaVersion: 1;
  lastProjectId: string | null;
  recents: RecentEntry[];
  projects: Record<string, ProjectSession>;
  window: { width: number; height: number; x?: number; y?: number };
}

interface ProjectSession {
  id: string;
  rootPath: string;
  name: string;
  source: ProjectSource;
  expandedPaths: string[];                  // absolute folder paths
  openTabs: Array<{
    path: string;                           // absolute file path
    viewState: monaco.editor.ICodeEditorViewState | null;
  }>;
  activeTabPath: string | null;
}
```

**Migration** — unknown / missing version → archive old file as `workspace.v0.bak`, write defaults. Future bumps add explicit upgraders keyed off the number.

### IPC channels (`ipc:hive:*` namespace)

| Channel | Direction | Payload → Result |
|---|---|---|
| `project:open-dialog` | renderer → main | — → `{ canceled, path? }` |
| `project:detect` | renderer → main | `path` → `Project` |
| `project:watch` | renderer → main | `path` → `watcherId` |
| `project:unwatch` | renderer → main | `watcherId` → void |
| `fs:read-file` | renderer → main | `path` → `{ contents, encoding }` |
| `fs:write-file` | renderer → main | `path, contents` → void |
| `fs:list-dir` | renderer → main | `path` → `DirEntry[]` |
| `fs:stat` | renderer → main | `path` → `Stat` |
| `fs:mkdir` | renderer → main | `path` → void |
| `fs:rename` | renderer → main | `from, to` → void |
| `fs:trash` | renderer → main | `path` → void |
| `fs:reveal-in-finder` | renderer → main | `path` → void |
| `fs:exists` | renderer → main | `path` → `boolean` |
| `state:get` | renderer → main | — → `PersistedState` |
| `state:save` | renderer → main | `state` → void (debounced 250 ms in main) |
| `shell:open-external` | renderer → main | `url` → void |
| `event:fs-changed` | main → renderer | `{ path, kind: 'add'\|'change'\|'unlink'\|'addDir'\|'unlinkDir' }` |
| `event:watch-error` | main → renderer | `{ watcherId, error }` |

```ts
interface DirEntry {
  name: string;
  path: string;           // absolute
  isDir: boolean;
  isSymlink: boolean;
  mtime: number;
}

interface Stat {
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
  ctime: number;
}
```

### Preload surface

```ts
// src/preload/api.ts
interface HiveBridge {
  platform: NodeJS.Platform;
  fs: {
    readFile(path: string): Promise<{ contents: string; encoding: 'utf8' | 'binary' }>;
    writeFile(path: string, contents: string): Promise<void>;
    listDir(path: string): Promise<DirEntry[]>;
    stat(path: string): Promise<Stat>;
    mkdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    trash(path: string): Promise<void>;
    revealInFinder(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
  };
  project: {
    openDialog(): Promise<{ canceled: boolean; path?: string }>;
    detect(path: string): Promise<Project>;
    watch(path: string): Promise<string>;       // returns watcherId
    unwatch(watcherId: string): Promise<void>;
  };
  state: {
    get(): Promise<PersistedState>;
    save(state: PersistedState): Promise<void>;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
  onFsChange(
    handler: (e: { path: string; kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' }) => void
  ): () => void;        // returns unsubscribe
}
```

Type definitions live in `src/preload/api.ts` (for `HiveBridge`) and `src/types/workspace.ts` (for `Project` / `Repo` / `PersistedState` / etc.). The renderer's `vite-env.d.ts` extends the `Window` interface so `window.hive` is typed everywhere.

### Save lifecycle

- Renderer calls `state.save(snapshot)` on tab open / close, project switch, every 5 s while editing
- Main debounces 250 ms before writing
- On `before-quit`, renderer flushes synchronously via `ipcRenderer.invoke('state:save', ...)`

### Path validation (main process)

- All `fs:*` channels validate: input is absolute, normalized, no `\0`, no `..` after normalization. Reject otherwise.
- **No project-root sandboxing** — the IDE has the user's full FS permissions like any editor. Reveal-in-Finder needs to walk outside the project sometimes.

### Boot sequence (cold start)

1. Main reads `workspace.json` (or writes defaults)
2. Main creates window using persisted `window` bounds
3. Renderer mounts, calls `state.get()` → hydrates Zustand store
4. If `lastProjectId` resolves to a `ProjectSession` and its `rootPath` still exists → reopen the project, restore `expandedPaths`, restore `openTabs` (with their `viewState`), focus `activeTabPath`
5. Otherwise → render Welcome (recents from `state.recents`)

## Mocked panels boundary

These panels keep their existing seed data and visuals — frozen until their own REQs:

| Surface | Source | Status in REQ-002 |
|---|---|---|
| Dock (run / stories / chat) | `seed.roster`, `seed.board`, `seed.chat` | Untouched. Hive REQ rewires. |
| Bottom panel (terminal / log / problems) | `seed.log`, `seed.problems`, hard-coded terminal | Untouched. Terminal+git REQ replaces. |
| PRsView | `seed.prs` | Untouched. Hive REQ wires real `gh pr list`. |
| Status bar middle ("next tick 00:38", "3 agents live") | hard-coded | Untouched cosmetically. Hive REQ makes real. |
| Status bar left (branch + ⚠) | `Repo.branch` not in REQ-002 (no git wiring yet) | New: branch chip is hidden entirely until the git REQ adds it. |

### Removed from `seed.ts`

- `FILE_CONTENTS`
- `tree`
- `openTabs`
- `AGENT_FILE`, `AGENT_INCOMING`
- `projects` (Welcome uses real recents)

### Kept in `seed.ts`

- `ROLE`
- `roster`
- `board`
- `chat`
- `log`
- `problems`
- `prs`

### Visual regressions this REQ accepts

- No agent-streaming demo in `oauth.ts` (the streaming view goes away)
- No M/A/U git markers in the tree
- No agent-color dot next to "agent-edited" files in the explorer
- Subtle "mock data — Hive not connected" ribbon at the top of Dock and BottomPanel to set expectations about what's wired

## Testing

### Unit tests (Vitest)

Both main and renderer use Vitest; renderer uses `happy-dom`.

| Module | What's covered |
|---|---|
| `main/project/detect.ts` | Detection rules: 4 cases × fixture filesystems via `mock-fs`. Asserts `source` + `repos[]` shape. |
| `main/fs/validate-path.ts` | Path validation: absolute-only, no `..` after normalize, no `\0`, no relative paths. |
| `main/state/migrate.ts` | Schema migration: missing version, future version, valid v1 pass-through. |
| `renderer/store/workspaceStore.ts` | Zustand actions: openTab, closeTab, markDirty, setActive, hydrateFromSession. |
| `renderer/store/recents.ts` | LRU recents update, max-10 cap. |
| `renderer/lib/languageForPath.ts` | Extension → Monaco language map. |

### Per-story QA gate (hive built-in)

Every story PR runs:

```bash
npm ci --no-audit --no-fund && npm run build && npm test
```

Same gate as REQ-001. `npm test` now actually runs Vitest.

### Manual E2E checklist (run after REQ merges)

```
☐ Cold start, no recents → Welcome shows, Open Folder works
☐ Open folder with .hive/config.yaml → teams appear as repos, source=hive
☐ Open parent folder of git repos → each appears as top-level root, source=auto-detected
☐ Open single git repo folder → appears alone, source=single-repo
☐ Open folder with no git → empty project, "no repos" state
☐ Edit + ⌘S + reload → contents persist on disk
☐ Quit + relaunch → same project, same tabs, cursor positions restored
☐ Switch projects via title-bar dropdown → tabs swap, dock stays (mock)
☐ External edit on clean buffer → silent reload, scroll preserved
☐ External edit on dirty buffer → banner with Reload / Keep / Compare(disabled)
☐ External delete of open file → tab closes, toast
☐ Rename via tree → open tab updates label and path
☐ Delete dirty file → confirm prompt; clean file → trash silently
☐ New file + new folder via context menu + ⌘N / ⌘⇧N
☐ Tree expand/collapse persists across relaunch
☐ Monaco TS smarts work on a .ts file (autocomplete, errors)
☐ ⌘P opens quick-file picker scoped to active project's repos
```

### Out of scope for testing

Monaco, chokidar, electron-store — battle-tested upstream. Spectron / Playwright-for-Electron E2E automation deferred to a future REQ.

## Story decomposition (for the tech lead)

Approximate sizing. The tech-lead AI may adjust; this is a guide.

| Story | File(s) | Pts | Role | depends_on |
|---|---|---|---|---|
| **STORY-015** Preload IPC types | `src/preload/api.ts`, `src/preload/index.ts` (with stub throws) | 1 | junior | — |
| **STORY-016** Main: project detection + shared types | `src/types/workspace.ts`, `src/main/project/detect.ts` + tests | 3 | junior | — |
| **STORY-017** Main: filesystem IPC | `src/main/fs/handlers.ts`, `src/main/fs/validate-path.ts` + tests | 3 | junior | STORY-015 |
| **STORY-018** Main: project lifecycle IPC + chokidar | `src/main/project/handlers.ts` | 5 | intermediate | STORY-015, STORY-016 |
| **STORY-019** Main: persisted state | `src/main/state/store.ts`, `src/main/state/migrate.ts` + tests | 3 | junior | STORY-015 |
| **STORY-020** Main: app bootstrap wire-up | `src/main/index.ts` rewires | 2 | junior | STORY-017, STORY-018, STORY-019 |
| **STORY-021** Renderer: Zustand store | `src/renderer/src/store/workspaceStore.ts` + tests | 5 | intermediate | — |
| **STORY-022** Renderer: language detection helper | `src/renderer/src/lib/languageForPath.ts` + tests | 1 | junior | — |
| **STORY-023** Renderer: MonacoEditor component | `src/renderer/src/components/MonacoEditor.tsx` | 5 | intermediate | STORY-022 |
| **STORY-024** Renderer: Editor rewrite | `src/renderer/src/components/Editor.tsx` rewires; deletes CodeEditor + AgentEditor | 5 | intermediate | STORY-021, STORY-023 |
| **STORY-025** Renderer: Explorer multi-root rewrite | `src/renderer/src/components/Explorer.tsx` rewires; context menu; inline rename / new | 8 | senior | STORY-021 |
| **STORY-026** Renderer: external-change banner | `src/renderer/src/components/Editor.tsx` banner additions | 3 | junior | STORY-021, STORY-024 |
| **STORY-027** Renderer: Welcome via ProjectsHub | `src/renderer/src/components/ProjectsHub.tsx` rewires to recents | 3 | junior | STORY-021 |
| **STORY-028** Renderer: App shell routing rewire | `src/renderer/src/App.tsx` rewires; ⌘O shortcut; removes seed.ts deps | 8 | senior | STORY-021, STORY-024, STORY-025, STORY-027 |
| **STORY-029** Renderer: mock-data ribbons | small additions to `Dock` + `BottomPanel` | 1 | junior | STORY-021 |

**Total:** ~56 pts across 15 stories. Larger than REQ-001 (~30 pts), expect ~2× the wall-clock time on the same `max_workers=5` cap.

## Done definition

REQ-002 is done when **all** of:

1. All 15 stories merged into `feat/real-files-editor`
2. `npm run build` green (per-story gate guarantees this)
3. Manual E2E checklist above passes locally on macOS
4. QA agent opens a PR merging `feat/real-files-editor` → `main` and that PR passes its own gate
