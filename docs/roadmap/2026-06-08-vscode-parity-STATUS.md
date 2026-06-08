# VSCode Parity Backlog — Implementation Status

**Branch:** `feat/vscode-parity` (worktree)
**Companion to:** `2026-06-08-vscode-parity-backlog.md`

Legend: ✅ done · 🟡 partial · ⏳ deferred (foundation may exist)

This worktree implements the entire recommended first milestone ("VSCode-lite":
all of Epic 1, Epic 2 P0/P1, Epic 4 P0, Epic 6 P0, Epic 9 P0, Epic 11 P0,
E7-01) **plus** the theme system, split editors, accessibility pass,
notifications, tab management, and the breakpoint + DAP-codec foundation of
debugging. ~580 tests pass; `tsc -b --noEmit` is clean.

---

## Epic 1 — Editor Core
- ✅ E1-01 Find (⌘F) · E1-02 Replace (⌘⌥F) · E1-03 Find options (Monaco built-in)
- ✅ E1-04 Multi-cursor (Monaco default, bindings documented)
- ✅ E1-05 Minimap toggle · E1-06 Code folding (gutter + fold/unfold commands)
- ✅ E1-07 Word wrap (⌥Z + setting) · E1-08 Sticky scroll · E1-09 Bracket-pair
  colorization + indent guides
- 🟡 E1-10 Go-to-bracket (auto-closing pairs on; explicit go-to-bracket command not bound)
- ✅ E1-11 Column selection (Monaco default) · E1-12 Zoom level (folded into font size, persisted)
- ✅ E1-13 Rename symbol (F2 → LSP rename) · E1-14 Trim trailing / final newline on save

All driven by the new settings store; see `MonacoEditor.tsx`, `useEditorCommands.ts`.

## Epic 2 — Search & Navigation
- ✅ E2-01 Global search backend (`src/main/search`, Node engine, glob excludes, binary skip)
- ✅ E2-02 Global search UI (`SearchView`, grouped results, highlight, options)
- ✅ E2-03 Quick-open over filesystem (⌘P, fuzzy file index)
- ✅ E2-04 Replace-in-files · E2-05 exclude globs (from `search.exclude`)
- ✅ E2-06 Go-to-symbol in file (⌘⇧O) · E2-08 Go-to-line (`:` in palette)
- ⏳ E2-07 workspace symbol · E2-09 search history · E2-10 context lines ·
  E2-11 references panel · E2-12 progress/cancel

## Epic 3 — Debugging (DAP)
- 🟡 E3-01 DAP client core — message codec (`src/main/debug/dapCodec.ts`, tested)
  landed; adapter-process session manager + IPC are the remaining work.
- ✅ E3-03 Breakpoints — gutter toggle + glyph decorations + per-file store
- ⏳ E3-02 launch.json · E3-04 toolbar/stepping · E3-05 call stack · E3-06 variables ·
  E3-07 debug console · E3-08..E3-14 — the live debug runtime + UI is the single
  largest deferred area. The codec + breakpoint store are the foundation.

## Epic 4 — Settings & Preferences
- ✅ E4-01 Settings store + `settings.json` (typed schema, merge, live broadcast)
- ✅ E4-02 Settings editor UI (searchable, typed inputs, reset, edit-in-JSON)
- ✅ E4-03 Keybindings registry (default + user layers, when-clauses)
- ✅ E4-05/06/07 per-language-ish/editor/EOL settings exposed · E4-09 format-on-save toggles
- 🟡 E4-04 Keybindings editor UI (registry done; dedicated editor UI deferred)
- ⏳ E4-08 workspace-scoped settings · E4-10 settings sync

## Epic 5 — Editor Layout & Tabs
- ✅ E5-01 Split editor groups (primary + secondary) · E5-02 Open to the side (⌘\, ⌘Enter, menu)
- ✅ E5-05 (pin is via context actions) · E5-07 close others/right/saved + reopen-closed (⌘⇧T)
- ⏳ E5-03 drag tab between groups · E5-04 preview tabs · E5-06 overflow dropdown ·
  E5-08 Open Editors view · E5-09 layout persistence · E5-10 grid presets

## Epic 6 — Commands & Command Palette
- ✅ E6-01 Command registry · E6-02 ⌘⇧P all-commands palette · E6-03 keybinding hints
- ✅ E6-04 recent-float + fuzzy · E6-05 when-clause context keys · E6-08 `>`/`:` prefixes
- 🟡 E6-06 migrate existing actions (chrome/editor/tab/view migrated; some legacy panels remain)
- ⏳ E6-07 reusable quick-pick primitive

## Epic 7 — Source Control Polish
- ✅ E7-01 Git decorations in the tree (M/A/U/D/R/C + folder roll-up)
- ✅ E7-05 Branch + ahead/behind status-bar indicator
- ⏳ E7-02 hunk-level staging · E7-03 editable diff · E7-04 inline diff gutter ·
  E7-06 merge conflict UI · E7-07 log view · E7-08 blame · E7-09 stash ·
  E7-10 amend · E7-11 stage/discard-all · E7-12 multi-root SCM grouping

## Epic 8 — Themes & Appearance
- ✅ E8-01 Theme system (Monaco theme + CSS variables) · E8-02 Light theme ·
  E8-03 Switcher (command + setting + follow-OS)
- ⏳ E8-04 plugin themes · E8-05 high-contrast · E8-06 file icon themes · E8-07 token overrides

## Epic 9 — Problems & Diagnostics
- ✅ E9-01 Problems panel (marker bridge → store, grouped, click-to-jump, live)
- ✅ E9-02 Code actions/quick fixes (⌘.) · E9-03 next/prev problem (F8/⇧F8)
- ✅ E9-04 problem count badges (status bar + panel tab) · E9-05 filter · E9-07 organize-imports/source-action
- ⏳ E9-06 workspace-wide diagnostics (only open files produce markers)

## Epic 10 — Extensions / Plugin Ecosystem
- ⏳ E10-01 marketplace · E10-02 auto-update · E10-03..E10-08 contribution points
  (commands/keybindings/configuration/themes/debuggers) · E10-09 extension host ·
  E10-10 recommendations. The command/keybinding/settings/theme **registries**
  these would target now exist, so contribution points are mostly a wiring task
  once an execution model (extension host) is chosen.

## Epic 11 — Status Bar & Workbench Chrome
- ✅ E11-01 Status bar framework (registerable left/right items, visibility setting)
- ✅ E11-02 cursor position · E11-03 language mode · E11-06 git branch · E11-07 problem counts
- ✅ E11-09 Notifications / toast system (center + bell badge)
- 🟡 E11-04 indentation indicator · E11-05 EOL/encoding (settings exist; status items not all added)
- ⏳ E11-08 background-task progress · E11-10 activity-bar polish · E11-11 zen mode

## Epic 12 — Accessibility
- ✅ E12-02 (Monaco accessibilitySupport auto + ARIA roles/labels) · E12-03 focus
  rings + landmarks · E12-05 reduce-motion
- 🟡 E12-01 keyboard nav (broadly present across views) · E12-04 high-contrast (ties to E8-05)
- ⏳ E12-06 context menus by keyboard · E12-07 accessibility help dialog

---

## Foundations delivered (unblock the rest)
- Settings store (E4-01) · Command + keybinding registries (E6-01/E4-03) ·
  Status bar framework (E11-01) · Search backend (E2-01) · Problems store +
  marker bridge (E9-01) · Theme system (E8-01) · DAP codec (E3-01).

## Largest remaining work
1. **Debugging runtime** (E3): DAP session manager + adapters + stepping/variables/console UI.
2. **Extension ecosystem** (E10): marketplace + contribution wiring + extension host.
3. **Advanced SCM** (E7): hunk-level staging, editable diff, merge editor, blame, stash, log.
