# Hive IDE — VSCode Parity Backlog

**Created:** 2026-06-08
**Scope:** Close the feature gaps between Hive IDE and a standard VSCode install. This backlog does **not** add net-new hive/agent orchestration features — those live in the hive slice plans.
**Status of IDE today:** Mature in editor (Monaco), terminal (xterm + node-pty, splits, persistence), git panel (status/stage/commit/diff/push/pull), plugin + LSP runtime, and session restore. The gaps below are the remaining distance to "feels like VSCode."

---

## How to read this

Each story has: **ID**, **priority**, **points**, a one-line intent, **acceptance criteria**, and **depends on**. Stories are grouped into epics ordered roughly by user-visible impact.

**Priority**
- **P0** — table-stakes; the IDE feels broken/incomplete without it. Daily-use blockers.
- **P1** — strongly expected by anyone coming from VSCode; ship soon after P0.
- **P2** — polish / power-user features; parity completeness.
- **P3** — long-tail nice-to-haves.

**Points** (Fibonacci, rough relative effort): 1, 2, 3, 5, 8, 13.

**Suggested execution order (first pass, P0 only):**
1. Find/Replace in file (E1) — biggest single daily-use gap
2. Global search (E2)
3. Quick-open over filesystem + go-to-line/symbol (E2)
4. Settings store + settings.json (E4)
5. Command registry + full command palette (E6)
6. Status bar framework (E11)
7. Problems panel (E9)
8. Git markers in tree (E7)

Then layer in Debugging (E3), Split editors (E5), Themes (E8), and polish.

---

## Epic 1 — Editor Core

The Monaco instance already does syntax highlighting, completions (TS/JS + plugin LSP), hover, and breadcrumbs. These stories surface Monaco capabilities that exist but aren't wired, plus a few that need config.

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E1-01** | P0 | 3 | **Find-in-file widget (⌘F)** |
| **E1-02** | P0 | 2 | **Replace-in-file (⌘H / toggle from find)** |
| **E1-03** | P1 | 2 | **Find options: case / whole-word / regex / in-selection** |
| **E1-04** | P1 | 1 | **Multi-cursor enablement + documented bindings** (⌥-click, ⌘D add-next-match, ⌘⇧L select-all-matches) |
| **E1-05** | P1 | 2 | **Minimap toggle** (off by default, on via settings/command) |
| **E1-06** | P1 | 2 | **Code-folding UI** (gutter chevrons, fold/unfold/fold-all commands; folding state already persisted) |
| **E1-07** | P1 | 1 | **Word-wrap toggle** (⌥Z, per-editor + default in settings) |
| **E1-08** | P2 | 1 | **Sticky scroll** (pinned scope headers at top of viewport) |
| **E1-09** | P2 | 1 | **Bracket-pair colorization + indent guides** |
| **E1-10** | P2 | 2 | **Go-to-bracket / select-to-bracket; auto-closing pairs from language config** |
| **E1-11** | P2 | 2 | **Column (box) selection** (⌥⇧-drag) and column paste |
| **E1-12** | P2 | 2 | **Persist & restore editor zoom level** across sessions |
| **E1-13** | P2 | 3 | **Rename symbol UX** — inline rename box + preview (LSP rename already exists; needs the F2 inline UI) |
| **E1-14** | P3 | 2 | **Trim-trailing-whitespace / insert-final-newline on save** (settings-driven) |

**E1-01 — Find-in-file widget (⌘F)** · P0 · 3
- *Intent:* Wire Monaco's built-in find widget so ⌘F opens it focused on the active editor.
- *Acceptance:* ⌘F opens find; Enter/⇧Enter cycle matches; Esc closes and restores cursor; match count shows; works in normal editor (not diff). Bound consistently across platforms (Ctrl+F on Win/Linux).
- *Depends on:* —
- *Notes:* `MonacoEditor.tsx` already mounts the editor; mostly enabling `find` action + binding. Verify it doesn't collide with the ⌘K palette.

**E1-02 — Replace-in-file (⌘H)** · P0 · 2
- *Acceptance:* ⌘H opens find+replace; Replace / Replace-All work; preserves undo as a single step where Monaco allows.
- *Depends on:* E1-01

**E1-03 — Find options** · P1 · 2
- *Acceptance:* Toggles for case-sensitive, whole-word, regex, and "find in selection" persist within the session; regex errors surface inline.
- *Depends on:* E1-01

**E1-13 — Rename symbol inline UX** · P2 · 3
- *Acceptance:* F2 on a symbol opens an inline rename input; Enter applies the LSP workspace edit across files; Esc cancels. Multi-file edits apply atomically and are reflected in open tabs + on disk.
- *Depends on:* existing LSP rename provider (`lspClient.ts`).

---

## Epic 2 — Search & Navigation

Today there is no project-wide search and ⌘P only searches open tabs. This epic is the second-biggest daily-use gap after find/replace.

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E2-01** | P0 | 8 | **Find-in-files (global search) — main-process search backend** |
| **E2-02** | P0 | 5 | **Global search UI panel** (results tree grouped by file, expandable, click-to-open at match) |
| **E2-03** | P0 | 5 | **Quick-open over filesystem (⌘P)** — fuzzy file search across all repos in project |
| **E2-04** | P1 | 5 | **Replace-in-files** (preview + apply across results, with per-file/per-match opt-out) |
| **E2-05** | P1 | 3 | **Search include/exclude globs** + respect `.gitignore` + toggle hidden/ignored |
| **E2-06** | P1 | 3 | **Go-to-symbol in file (⌘⇧O)** — outline-backed symbol jump |
| **E2-07** | P1 | 5 | **Go-to-symbol in workspace (⌘T)** — LSP `workspace/symbol` across repos |
| **E2-08** | P1 | 1 | **Go-to-line (⌘G / ⌘P with `:`)** |
| **E2-09** | P2 | 3 | **Search history + recent searches; persist last query/options** |
| **E2-10** | P2 | 3 | **Search result context lines + match highlighting in the result row** |
| **E2-11** | P2 | 2 | **"Find references" results panel** (LSP references already exist; needs a list UI, not just peek) |
| **E2-12** | P3 | 2 | **Search badge counts + "searching…" progress + cancel** |

**E2-01 — Global search backend** · P0 · 8
- *Intent:* Add a main-process IPC handler that searches file contents across all project repos. Prefer shelling to `ripgrep` if available (bundle or detect), fall back to a Node streaming scanner.
- *Acceptance:* `search:files({query, opts})` streams results (path, line, col, preview, match ranges) to the renderer incrementally; honors case/word/regex; cancellable; respects `.gitignore` and a configurable exclude list; bounded result cap with "show more".
- *Depends on:* —
- *Notes:* New file under `src/main/search/`. Mirror the streaming pattern used by the hive runner / git handlers.

**E2-03 — Quick-open over filesystem (⌘P)** · P0 · 5
- *Intent:* Replace the tabs-only ⌘P (see comment in `CommandPalette.tsx:93`) with a fuzzy file finder over the whole project filesystem.
- *Acceptance:* ⌘P lists files across all repos, fuzzy-ranked; respects ignore rules; recently-opened float to top; Enter opens, ⌘Enter opens to the side (once E5 split exists); fast on large repos (index or lazy walk with debounce).
- *Depends on:* file walker (can share with E2-01).

---

## Epic 3 — Debugging (DAP)

No debugging today. This is the largest single missing subsystem vs VSCode. Build a Debug Adapter Protocol client in main, a debug UI in the renderer, and config via `launch.json`.

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E3-01** | P0 | 8 | **DAP client core (main)** — spawn/attach debug adapters, JSON-RPC transport, lifecycle |
| **E3-02** | P0 | 5 | **`launch.json` schema + config loading + run/debug config picker** |
| **E3-03** | P0 | 5 | **Breakpoints** — gutter set/remove, persist per file, send to adapter |
| **E3-04** | P0 | 5 | **Debug toolbar + stepping** (continue, step over/into/out, restart, stop, pause) |
| **E3-05** | P0 | 5 | **Call stack + threads view** |
| **E3-06** | P0 | 5 | **Variables + scopes view** (expandable tree, lazy children) |
| **E3-07** | P0 | 3 | **Debug console / REPL** (evaluate in frame, show adapter output) |
| **E3-08** | P1 | 3 | **Watch expressions** |
| **E3-09** | P1 | 3 | **Current-line highlight + inline values during break** |
| **E3-10** | P1 | 3 | **Conditional / hit-count / logpoint breakpoints** |
| **E3-11** | P1 | 2 | **Exception breakpoints (caught/uncaught toggles)** |
| **E3-12** | P2 | 3 | **Debug adapters as plugin contributions** (`contributes.debuggers` in plugin.json) |
| **E3-13** | P2 | 2 | **Hover-to-evaluate while paused** |
| **E3-14** | P2 | 3 | **Built-in Node.js debug adapter wiring** (first concrete adapter to validate the stack) |

**E3-01 — DAP client core** · P0 · 8
- *Acceptance:* Can launch an adapter process, perform the `initialize`/`launch`/`configurationDone` handshake, route requests/events/responses, and forward events to the renderer over IPC. Clean teardown on stop/crash. Single active session in v1.
- *Depends on:* —
- *Notes:* Reuse `vscode-jsonrpc` patterns from the LSP bridge (`src/main/plugins/lsp/`).

---

## Epic 4 — Settings & Preferences

No settings system today (theme hard-coded, keybindings hard-wired in components, no preferences file). This unblocks many other stories (theme switching, per-editor toggles, keybinding customization).

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E4-01** | P0 | 5 | **Settings store + `settings.json`** (defaults → user → workspace merge, typed schema, live updates) |
| **E4-02** | P0 | 5 | **Settings editor UI** (searchable, grouped, typed inputs; "edit in JSON" escape hatch) |
| **E4-03** | P0 | 5 | **Keybindings registry** — extract all hard-wired bindings into a central, queryable registry |
| **E4-04** | P1 | 5 | **Keybindings editor UI** (list, search, rebind, conflict detection, reset) |
| **E4-05** | P1 | 3 | **Per-language settings** (tab size, insert-spaces, format-on-save, default formatter) |
| **E4-06** | P1 | 2 | **Editor settings surface** (font family/size/ligatures, line height, cursor style, render-whitespace) |
| **E4-07** | P1 | 2 | **EOL + encoding settings** (default + per-file override; status-bar entry in E11) |
| **E4-08** | P2 | 3 | **Workspace-scoped settings** (`.hive/settings.json` or `.vscode`-style) layered over user |
| **E4-09** | P2 | 2 | **Format-on-save / format-on-paste / format-on-type toggles** (uses LSP formatting) |
| **E4-10** | P3 | 3 | **Settings sync / export-import profile** |

**E4-01 — Settings store + settings.json** · P0 · 5
- *Acceptance:* A typed settings schema with defaults; user settings persisted to a JSON file (alongside `electron-store` state or a discrete file); a renderer-side reactive accessor so components read settings without prop-drilling; changes apply live without restart where feasible.
- *Depends on:* —
- *Notes:* Foundation for E1-05/07/12/14, E5 defaults, E8 theme, E4-03.

**E4-03 — Keybindings registry** · P0 · 5
- *Intent:* Today bindings are scattered across `App.tsx`, `Explorer.tsx`, `Terminal*.tsx`, etc. Centralize them.
- *Acceptance:* A single registry maps command-id → default binding(s) + when-clause; components dispatch by command-id, not raw key handlers; the palette (E6) and keybinding editor (E4-04) read from it; no behavioral regressions (cover existing bindings with tests).
- *Depends on:* benefits from E6-01 (command registry) — build together.

---

## Epic 5 — Editor Layout & Tabs

Single tab strip today; no split editors. VSCode users expect side-by-side editing and editor groups.

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E5-01** | P1 | 13 | **Split editor groups** (vertical + horizontal), independent tab strips, focus tracking |
| **E5-02** | P1 | 5 | **Open-to-the-side** (⌘\, ⌘Enter from quick-open, context menu) |
| **E5-03** | P1 | 5 | **Drag tab to split / move tab between groups** |
| **E5-04** | P2 | 3 | **Preview tabs** (single-click preview italic, double-click/edit pins) |
| **E5-05** | P2 | 2 | **Pin / unpin tabs** |
| **E5-06** | P2 | 2 | **Tab overflow dropdown + scrollable tab strip** |
| **E5-07** | P2 | 2 | **Close others / close to the right / close saved / reopen-closed (⌘⇧T)** |
| **E5-08** | P2 | 3 | **"Open Editors" view** in the sidebar (group-aware list of dirty/open files) |
| **E5-09** | P3 | 3 | **Editor group layout persistence** across sessions |
| **E5-10** | P3 | 2 | **Grid layout presets** (two-column, three-column, grid 2x2) |

**E5-01 — Split editor groups** · P1 · 13
- *Intent:* Introduce an editor-group tree (mirror the terminal pane-tree approach in `lib/paneTree.ts`) so the renderer can host N Monaco groups with resizable dividers.
- *Acceptance:* Can split active editor right/down; each group has its own tabs + active tab; closing the last tab in a group collapses it; resizing persists for the session; keyboard focus moves between groups (⌘1/⌘2…).
- *Depends on:* —
- *Notes:* Largest renderer refactor in this backlog; the existing terminal pane-tree is a strong reference implementation.

---

## Epic 6 — Commands & Command Palette

Palette today is a hardcoded action list (`CommandPalette.tsx`). VSCode's palette is driven by a command registry every feature contributes to.

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E6-01** | P0 | 5 | **Command registry** — central `registerCommand(id, handler, {title, category, when})` |
| **E6-02** | P0 | 3 | **All-commands palette (⌘⇧P)** driven by the registry, with category prefixes |
| **E6-03** | P1 | 2 | **Keybinding hints shown next to commands** in the palette |
| **E6-04** | P1 | 2 | **Recently-used commands float to top; fuzzy match** |
| **E6-05** | P1 | 2 | **When-clause context keys** (editorFocus, hasGitRepo, debugging, etc.) gate commands/bindings |
| **E6-06** | P2 | 3 | **Migrate existing actions** (palette stubs, file ops, terminal, git) onto the registry |
| **E6-07** | P2 | 2 | **Quick-pick primitive** (reusable command-palette-style chooser for any feature) |
| **E6-08** | P2 | 2 | **Command palette `>`/`@`/`:`/`#` mode prefixes** (commands / symbols / line / workspace-symbols) |

**E6-01 — Command registry** · P0 · 5
- *Acceptance:* Any feature can register a command with id/title/category/when; commands are invokable from the palette (E6-02), keybindings (E4-03), and menus; duplicate-id detection in dev.
- *Depends on:* — (build alongside E4-03)

---

## Epic 7 — Source Control Polish

Git panel is solid (status/stage/unstage/discard/commit/push/pull/branches/diff). These close the remaining VSCode SCM gaps.

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E7-01** | P0 | 3 | **Git decorations in the file tree** (M/A/U/D color + badge; the chip placeholder already exists, unpopulated) |
| **E7-02** | P1 | 5 | **Hunk-level / line-level staging** (stage/unstage/revert selected hunks) |
| **E7-03** | P1 | 3 | **Editable diff view** (current diff is read-only v1; allow editing the working-tree side) |
| **E7-04** | P1 | 3 | **Inline diff gutter decorations** (added/modified/deleted markers + revert-hunk popover in the editor) |
| **E7-05** | P1 | 3 | **Branch + sync indicator in the status bar** (current branch, ahead/behind, click to switch) |
| **E7-06** | P1 | 5 | **Merge conflict resolution UI** (accept current/incoming/both, 3-way merge editor) |
| **E7-07** | P2 | 3 | **Commit history / log view** per repo (graph optional) |
| **E7-08** | P2 | 3 | **Git blame** (inline annotation + gutter) |
| **E7-09** | P2 | 2 | **Stash create / apply / pop / drop** |
| **E7-10** | P2 | 2 | **Amend last commit + commit message history recall** |
| **E7-11** | P2 | 2 | **Discard-all / stage-all / unstage-all with confirm** |
| **E7-12** | P3 | 2 | **Per-repo SCM grouping when multiple repos have changes** (multi-root SCM view) |

**E7-01 — Git decorations in tree** · P0 · 3
- *Acceptance:* Files in the explorer show git status color + letter badge; folders roll up a change indicator; updates on the existing 500ms debounced git refresh; respects ignored files.
- *Depends on:* existing git status (`src/main/git/`) + the unpopulated chip in `Explorer.tsx`.

---

## Epic 8 — Themes & Appearance

Single hard-coded `vs-dark` theme. Needs a theme system, a light theme, and switching UI.

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E8-01** | P1 | 5 | **Theme system** — map a theme definition to both Monaco theme + app CSS variables (`ide.css` tokens) |
| **E8-02** | P1 | 2 | **Light theme** (full token set, parity with dark) |
| **E8-03** | P1 | 2 | **Theme switcher** (command + settings; "follow OS" option) |
| **E8-04** | P2 | 3 | **Themes as plugin contributions** (`contributes.themes`) |
| **E8-05** | P2 | 3 | **High-contrast theme** (ties into accessibility, E12) |
| **E8-06** | P2 | 3 | **File icon themes** (icon set selectable; current icons are lucide type-mapped) |
| **E8-07** | P3 | 2 | **Per-token color customization override** in settings |

**E8-01 — Theme system** · P1 · 5
- *Acceptance:* A theme is a single source of truth that drives Monaco's `defineTheme` AND the app's CSS custom properties; switching at runtime re-themes editor + chrome without reload.
- *Depends on:* E4-01 (settings store) to persist the selection.

---

## Epic 9 — Problems & Diagnostics

LSP diagnostics are published but there's no aggregated Problems panel or code-action UI.

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E9-01** | P0 | 3 | **Problems panel** — aggregate diagnostics across open files/project, grouped by file, click-to-jump |
| **E9-02** | P1 | 3 | **Code actions / quick fixes (⌘.)** — lightbulb + menu driven by LSP `textDocument/codeAction` |
| **E9-03** | P1 | 2 | **Go-to-next/prev problem (F8 / ⇧F8)** |
| **E9-04** | P1 | 2 | **Problem count badges** (status bar + panel tab + per-file in tree/tabs) |
| **E9-05** | P2 | 2 | **Filter problems by severity / by file / by text** |
| **E9-06** | P2 | 3 | **Workspace-wide diagnostics** (not just open files) where the LSP supports it |
| **E9-07** | P2 | 2 | **Source action / organize-imports / fix-all commands** |

**E9-01 — Problems panel** · P0 · 3
- *Acceptance:* A bottom-panel "Problems" tab lists all current diagnostics (error/warning/info/hint) with file, line, message, source; clicking navigates to the location; live-updates as diagnostics change.
- *Depends on:* existing diagnostics flow in `lspClient.ts`; bottom panel already hosts log/terminal tabs.

---

## Epic 10 — Extensions / Plugin Ecosystem

Plugin runtime is real (languages, LSP, setup downloads, per-project enable, install from folder/GitHub). Missing the ecosystem layer + more contribution points.

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E10-01** | P1 | 8 | **Extension registry / marketplace browse + install** (search a registry, install by id, show README) |
| **E10-02** | P1 | 3 | **Plugin auto-update + version/update-available indicator** |
| **E10-03** | P1 | 3 | **`contributes.commands`** — plugins register palette commands |
| **E10-04** | P1 | 3 | **`contributes.keybindings`** — plugins register default bindings (via E4-03) |
| **E10-05** | P1 | 3 | **`contributes.configuration`** — plugins contribute settings (via E4-01/02) |
| **E10-06** | P2 | 5 | **`contributes.debuggers`** (DAP via plugin; ties to E3-12) |
| **E10-07** | P2 | 3 | **`contributes.themes`** (ties to E8-04) |
| **E10-08** | P2 | 3 | **Plugin dependency declaration + resolution** |
| **E10-09** | P2 | 5 | **Extension host isolation** (run plugin JS in a sandboxed context, not main) |
| **E10-10** | P3 | 3 | **Extension recommendations per workspace** |

**E10-01 — Marketplace browse + install** · P1 · 8
- *Acceptance:* A Plugins view tab can search a configured registry, show results with description/version/README, and install by id (downloading into the existing plugin storage). Reuses current install/uninstall plumbing (`src/main/plugins/`).
- *Depends on:* a registry source decision (own index JSON vs Open VSX-compatible). Capture that decision in a spec before building.

---

## Epic 11 — Status Bar & Workbench Chrome

No status bar today. It's a high-visibility parity gap and a host for several other stories (git, EOL, problems, language mode).

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E11-01** | P0 | 3 | **Status bar framework** — left/right item slots, click handlers, tooltips, contributable |
| **E11-02** | P1 | 1 | **Cursor position (line/col) + selection count** |
| **E11-03** | P1 | 1 | **Language mode indicator** (click → change language for file) |
| **E11-04** | P1 | 1 | **Indentation indicator** (spaces/tabs + size; click → change) |
| **E11-05** | P1 | 1 | **EOL + encoding indicators** (click → change; pairs with E4-07) |
| **E11-06** | P1 | 2 | **Git branch + ahead/behind** (pairs with E7-05) |
| **E11-07** | P1 | 1 | **Problems counts** (errors/warnings; pairs with E9-04) |
| **E11-08** | P2 | 2 | **Background task / progress indicator** (long-running ops: search, git, LSP indexing, hive runs) |
| **E11-09** | P2 | 2 | **Notifications / toast system** (info/warn/error, actions, dismiss, history) |
| **E11-10** | P2 | 2 | **Activity bar polish** — badges, reorder, show/hide views |
| **E11-11** | P3 | 2 | **Zen mode / centered layout / toggle panel-sidebar-statusbar visibility** |

**E11-01 — Status bar framework** · P0 · 3
- *Acceptance:* A persistent bottom status bar with left/right aligned, prioritized item slots; items can be registered by features with text/icon/tooltip/command; hidden by a setting.
- *Depends on:* —

---

## Epic 12 — Accessibility & Editor UX Completeness

| ID | Pri | Pts | Story |
|----|-----|-----|-------|
| **E12-01** | P1 | 3 | **Keyboard navigation across all views** (explorer, SCM, search, panels) without mouse |
| **E12-02** | P1 | 3 | **Screen-reader support** (ARIA roles/labels; Monaco accessibility mode toggle) |
| **E12-03** | P1 | 2 | **Focus management + visible focus rings** (tab order, focus trap in modals, restore focus on close) |
| **E12-04** | P2 | 2 | **High-contrast theme support** (ties to E8-05) |
| **E12-05** | P2 | 2 | **Reduce-motion + font-scaling respect** |
| **E12-06** | P2 | 2 | **Context menus reachable by keyboard** (menu key / ⇧F10) |
| **E12-07** | P3 | 2 | **Accessibility help dialog** (per-view shortcut summaries) |

---

## Coverage check vs the gap analysis

The critical/moderate gaps identified in the feature inventory all map to stories above:

| Gap from inventory | Covered by |
|---|---|
| Find-in-file / Replace | E1-01, E1-02, E1-03 |
| Find-in-files (global search) | E2-01, E2-02, E2-04, E2-05 |
| Quick-open over filesystem (⌘P) | E2-03 |
| Debugging (DAP, breakpoints, console) | Epic 3 |
| Split editor panes | E5-01, E5-02, E5-03 |
| Settings UI / preferences file | E4-01, E4-02 |
| Customizable keybindings | E4-03, E4-04 |
| Theme switching / light theme | E8-01, E8-02, E8-03 |
| Plugin marketplace | E10-01, E10-02 |
| Git markers in tree | E7-01 |
| Hunk-level staging | E7-02 |
| Editable diff | E7-03 |
| Branch switcher in status bar | E7-05, E11-06 |
| Multi-cursor (not exposed) | E1-04 |
| Minimap / code folding UI | E1-05, E1-06 |
| Problems panel + code actions | E9-01, E9-02 |
| Status bar (absent) | Epic 11 |
| Command registry / full palette (⌘⇧P) | E6-01, E6-02 |
| Go-to-symbol / go-to-line | E2-06, E2-07, E2-08 |

## Rough totals

- **~95 stories** across **12 epics**.
- **P0 (~22 stories):** the daily-use blockers — find/replace, global search, quick-open, settings store, command registry, status bar framework, problems panel, git tree decorations, and the debugging core.
- Recommended first milestone ("VSCode-lite"): all of Epic 1 + Epic 2 P0/P1 + Epic 4 P0 + Epic 6 P0 + Epic 9 P0 + Epic 11 P0 + Epic 7-01. That alone closes the gaps a returning VSCode user notices in the first ten minutes.

## Notes for whoever executes this

- Several stories are foundational and unblock others — build them first within their epic: **E4-01** (settings store), **E4-03/E6-01** (keybinding + command registry, build together), **E11-01** (status bar framework), **E2-01** (search backend, shared by global search + quick-open).
- The terminal pane-tree (`src/renderer/src/lib/paneTree.ts`) is the reference implementation for **E5-01** (split editors).
- The LSP bridge (`src/main/plugins/lsp/`) is the reference implementation for **E3-01** (DAP client) — same `vscode-jsonrpc` transport shape.
- Write a short design spec under `docs/specs/` before the large stories (E3-01, E5-01, E10-01) — they have real architectural decisions.
