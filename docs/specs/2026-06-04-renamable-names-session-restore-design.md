# Renamable project/terminal names + fuller session restore

**Status:** Approved (design)
**Date:** 2026-06-04

## Problem

Two gaps in the IDE shell:

1. **Names aren't editable.** A project's name is fixed at creation
   (`renameProject` exists in the store and is unit-tested, but nothing in the
   UI calls it). Terminal tabs are hardcoded `Term 1`, `Term 2`…; full-screen
   terminal sessions take a derived title. The user can't rename any of them.

2. **The session doesn't fully reopen the way it was closed.** Open files
   (with Monaco scroll + cursor + folds), the active tab, expanded explorer
   folders, the last active project, panel layout sizes, recents, and enabled
   plugins *already* persist and restore. But the **active view**
   (Explorer / Source Control / Terminal / Plugins / PRs / Projects), the
   **bottom-panel open state + active tab**, and the **terminal sessions/tabs**
   reset on every relaunch.

## Goals

- Make **project names** renamable (ProjectsHub rows + the title-bar project
  name).
- Make **both terminal surfaces** renamable: the bottom-panel terminal tabs and
  the full-screen ("Warp-style") terminal sessions.
- Restore on relaunch, in addition to what already restores: the **active
  view**, the **bottom-panel open state + active tab**, and the **terminal
  tabs/sessions** (names + working directory + split layout).
- Rename interaction: **double-click to edit inline** AND a **right-click
  "Rename"** context-menu entry, on every renamable surface.

## Non-goals / explicit constraints

- **Live shells are not resurrected.** A terminal is an OS process (pty); it
  cannot survive an app quit. On relaunch we re-create the terminal
  tabs/sessions with their saved **name + working directory + split layout** and
  start **fresh** shells. This is the realistic, documented behavior.
- No change to the existing tab/editor/layout/plugin persistence — we extend it,
  not rewrite it.
- Pane *titles* inside a full-screen session stay derived; only the **session**
  name is user-editable (matches the scope agreed with the user).

## Approach (chosen: store-centric)

Lift the currently component-local UI-routing state (`view`, `panelOpen`,
`panelTab`) and the **serializable** terminal structure into the Zustand
workspace store. The existing persistence pipeline —
`buildSnapshot` → `window.hive.state.save` → `migrate`/`hydrateFromSession` —
then carries the new state for free, exactly the way `openTabs` works today.
Rename is a store action (projects: the existing `renameProject`; terminals: new
title setters) plus two small shared UI primitives reused across all three
surfaces.

Rejected alternatives:

- **Refs + callbacks** (keep state local, thread refs up to App so
  `buildSnapshot` can read them): mixes refs with the store, makes
  `buildSnapshot` impure, edges easy to miss, harder to test.
- **Minimal** (persist active view + panel only, terminal rename UI without
  terminal persistence): fails the agreed scope (terminal sessions must
  restore).

## Components & data flow

### 1. Shared types — `src/types/workspace.ts`

- Relocate `PaneNode` and `SplitDir` from `src/renderer/src/lib/paneTree.ts`
  into shared types; `paneTree.ts` re-exports them so existing imports are
  unaffected. `PaneNode` is a pure data tree, safe to persist.
- New serializable terminal shapes:

  ```ts
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

  /** One full-screen terminal session (serializable layout only). */
  export interface TermSessionSnapshot {
    id: string
    group: string
    title: string
    branch: string
    root: PaneNode
    activePane: string
    panes: Record<string, TermPaneMeta>
  }
  ```

- Extend `ProjectSession` and `ProjectSessionSnapshot` with optional fields
  (all optional so pre-existing sessions remain valid):

  ```ts
  activeView?: 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term'
  panelOpen?: boolean
  panelTab?: 'terminal' | 'log' | 'problems'
  panelTerminals?: PanelTerminalTab[]
  activePanelTerminalId?: string | null
  termSessions?: TermSessionSnapshot[]
  activeTermSessionId?: string | null
  ```

  `ViewKey` and `BottomPanelTab` are currently declared in `App.tsx` /
  `BottomPanel.tsx`. To avoid a cross-import from shared types into the
  renderer, the shared types inline the string-literal unions (as above);
  `App.tsx`/`BottomPanel.tsx` keep their local aliases, which structurally
  match.

- Bump `PersistedState.schemaVersion` from `4` to `5`.

### 2. Migration — `src/main/state/migrate.ts`

- `defaults()` returns `schemaVersion: 5`.
- Add a shape-preserving `v4 → v5` upgrade: carry every existing field; no new
  top-level fields are required (the additions live inside `ProjectSession` and
  are optional), so the upgrade is effectively a version bump that preserves
  `projects`, `recents`, `layout`, `enabledPlugins`, `window`, `lastProjectId`.
- Re-point the v2→ and v3→ upgrade chains to terminate at v5.
- Structural validation (`isValidV5`) mirrors `isValidV4` plus the version
  check. Per-`ProjectSession` field validation is **not** tightened — the new
  fields are optional and the renderer tolerates their absence.
- No backup is written for v4→v5 (real user data is carried forward).

### 3. Store — `src/renderer/src/store/workspaceStore.ts`

New state + actions:

- **UI routing:** `activeView`, `panelOpen`, `panelTab` with
  `setActiveView`, `setPanelOpen`, `setPanelTab`.
- **Terminal mirror:** `panelTerminals`, `activePanelTerminalId`,
  `termSessions`, `activeTermSessionId` with
  `setPanelTerminals`, `setActivePanelTerminalId`, `setTermSessions`,
  `setActiveTermSessionId`. These are write-through mirrors of the terminal
  components' serializable structure — the components own their live state and
  push the persistable shape here on change.
- `setProject` / `closeProject` / `createProject` reset all new fields to
  defaults (`activeView: 'ide'`, `panelOpen: true`, `panelTab: 'log'`,
  empty terminal arrays, `null` active ids) — same "clear on project swap"
  contract the existing fields already follow.
- `hydrateFromSession(snapshot)` restores the new fields from the snapshot,
  falling back to the same defaults when a field is absent.
- `renameProject(id, name)` is unchanged (already implemented + tested); the new
  UI simply calls it.

### 4. App shell — `src/renderer/src/App.tsx`

- Replace the `view` / `panelOpen` / `panelTab` `useState` hooks with the store
  fields + setters. All existing readers/writers switch to the store.
- `buildSnapshot` writes the seven new fields into the active project's
  `ProjectSession` (reading them off `useWorkspaceStore.getState()`, consistent
  with how it already reads `openTabs`).
- Boot + `enterRecent` pass the new fields into `hydrateFromSession`.
- When the restored `activeView === 'term'`, set `termMounted` so the
  full-screen terminal mounts on launch.
- The title-bar project name (`.proj-switch .pn`) becomes double-click-renamable
  via the shared `InlineEditable` (commits through `renameProject`).

### 5. Terminal components

**Bottom-panel — `src/renderer/src/components/Terminal.tsx` (`TerminalPanel`):**

- Seed `tabs` from `store.panelTerminals` if non-empty on first mount, else the
  current single-tab default. Seed `activeTabId` from
  `store.activePanelTerminalId`.
- A `useEffect` mirrors `tabs` (as `{ tabId, title, cwd }`) and `activeTabId`
  into the store on change (`setPanelTerminals` / `setActivePanelTerminalId`).
- `TabEntry` gains nothing structurally; `cwd` is captured per tab at seed time
  so it survives restore.
- Each `TermTabChip` label becomes renamable (double-click + context menu).

**Full-screen — `src/renderer/src/components/TerminalView.tsx`:**

- Seed `sessions` / `panes` / `activeId` from
  `store.termSessions` / `store.activeTermSessionId` when present, else the
  existing single-session seed.
- A `useEffect` mirrors the serializable `sessions` (id, group, title, branch,
  `root`, `activePane`) and `panes` (title, cwd, branch — dropping `exited` and
  live state) plus `activeId` into the store
  (`setTermSessions` / `setActiveTermSessionId`).
- Each session row title becomes renamable (double-click + context menu),
  committing through `setTermSessions` (updating that session's `title`).
- The module-level `SEQ`/`uid` id generator stays; restored ids are reused
  as-is, and `SEQ` only needs to avoid colliding with *new* ids minted in the
  same run (restored ids are namespaced strings, so collisions are a non-issue
  in practice — new ids use the running counter).

### 6. Shared UI primitives — `src/renderer/src/components/primitives/`

- **`InlineEditable`** — renders its text; double-click swaps to a focused
  `<input>` seeded with the current value; **Enter** or **blur** commits the
  trimmed value (no-op when empty/unchanged); **Esc** cancels. Exposes an
  imperative `startEditing()` (or an externally-controlled `editing` prop) so a
  context-menu "Rename" can trigger the same editor.
- **`ContextMenu`** — a cursor-anchored popup rendered on `onContextMenu`,
  taking a list of `{ label, onSelect }` items and an outside-click scrim to
  dismiss. Reuses the existing `.menu` / `.menu-item` styling.
- Both are exported from `components/primitives/index.ts`.

## Error handling

- Rename ignores empty/whitespace-only input (commit is a no-op, editor closes).
- A persisted `activeView` / `panelTab` that's no longer a valid value falls
  back to defaults during hydration (defensive narrowing).
- Restored terminal sessions whose `cwd` no longer exists on disk: the fresh
  shell spawn falls back to `os.homedir()` (existing `terminal:spawn` behavior in
  `src/main/terminal/handlers.ts` — no change needed).
- Malformed persisted terminal structures (e.g. a `root` that isn't a valid
  `PaneNode`) are tolerated by seeding the default single session; the mirror
  effect overwrites the bad value on first interaction.

## Testing (TDD)

- **Store** (`workspaceStore.test.ts`): new setters mutate as expected;
  `hydrateFromSession` round-trips the new fields; `setProject`/`createProject`
  reset them to defaults; `renameProject` already covered.
- **Migration** (`migrate.test.ts`): a v4 payload upgrades to v5 carrying all
  data; a valid v5 passes through reference-equal; v2/v3 still terminate at v5;
  garbage still archives + resets.
- **Primitives**: `InlineEditable` commits on Enter/blur, cancels on Esc,
  ignores empty; `ContextMenu` opens at cursor and fires `onSelect`.
- Terminal write-through is exercised through the store tests (the components'
  serializable mirror shape) rather than full xterm/pty integration.

## Out-of-scope follow-ups (not in this change)

- Persisting terminal *scrollback* or shell history.
- Renaming individual panes within a full-screen session.
- Per-project (vs last-project-only) restore of multiple projects' sessions
  simultaneously.
