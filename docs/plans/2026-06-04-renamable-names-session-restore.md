# Renamable project/terminal names + fuller session restore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project names and both terminal surfaces (bottom-panel tabs + full-screen sessions) renamable, and restore the active view, bottom-panel state, and terminal tabs/sessions on relaunch.

**Architecture:** Store-centric. Lift UI-routing state (`activeView`, `panelOpen`, `panelTab`) and the serializable terminal structure into the Zustand workspace store. The existing persistence pipeline (`buildSnapshot` → `state.save` → `migrate`/`hydrateFromSession`) carries the new state for free. Rename is the existing `renameProject` action plus new terminal-title setters, wired through two small shared UI primitives.

**Tech Stack:** Electron + React + TypeScript, Zustand, electron-store, Vitest (happy-dom for renderer, node for main), Monaco, xterm.js.

**Spec:** `docs/specs/2026-06-04-renamable-names-session-restore-design.md`

**Conventions for every task:**
- Run renderer/main tests with `npx vitest run <path>` (single file) or `npm test` (full suite).
- TypeScript: **no `any`**. Type-only imports across process boundaries.
- Commit message footer is omitted in the snippets below for brevity — use the repo's normal style.

---

## File Structure

**Modify:**
- `src/types/workspace.ts` — relocate `PaneNode`/`SplitDir`; add terminal-session persisted shapes; extend `ProjectSession` + `ProjectSessionSnapshot`; bump `schemaVersion` to `5`.
- `src/renderer/src/lib/paneTree.ts` — re-export `PaneNode`/`SplitDir` from shared types instead of declaring them.
- `src/main/state/migrate.ts` — `defaults()` → v5; add `isValidV5` + `v4→v5` upgrade; route v2/v3 chains to v5.
- `src/main/state/migrate.test.ts` — update expectations to v5; add v4→v5 + v5 pass-through cases.
- `src/renderer/src/store/workspaceStore.ts` — add UI-routing + terminal-mirror slices; reset on project swap; restore in `hydrateFromSession`.
- `src/renderer/src/store/workspaceStore.test.ts` — cover new setters + hydrate/reset round-trip.
- `src/renderer/src/App.tsx` — replace `view`/`panelOpen`/`panelTab` `useState` with store; extend `buildSnapshot` + hydration; title-bar rename.
- `src/renderer/src/components/Terminal.tsx` — seed from store; write-through mirror; renamable tab chips.
- `src/renderer/src/components/TerminalView.tsx` — seed from store; write-through mirror; renamable session rows.
- `src/renderer/src/components/ProjectsHub.tsx` — renamable project rows (inline + context menu).
- `src/renderer/src/components/primitives/index.ts` — export new primitives.

**Create:**
- `src/renderer/src/components/primitives/InlineEditable.tsx`
- `src/renderer/src/components/primitives/InlineEditable.test.tsx`
- `src/renderer/src/components/primitives/ContextMenu.tsx`
- `src/renderer/src/components/primitives/ContextMenu.test.tsx`

---

## Task 1: Shared types — terminal shapes + extended session + schema bump

**Files:**
- Modify: `src/types/workspace.ts`
- Modify: `src/renderer/src/lib/paneTree.ts`

- [ ] **Step 1: Add `PaneNode`/`SplitDir` + terminal shapes to shared types**

In `src/types/workspace.ts`, add near the top of the file (after the existing `Repo`/`Project` block is fine; keep it grouped under a new banner comment):

```ts
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
```

- [ ] **Step 2: Extend `ProjectSession` with the new optional fields**

In `src/types/workspace.ts`, inside `interface ProjectSession`, add after `hiveWorkspacePath?`:

```ts
  /** View that was foreground on close. Absent → 'ide'. */
  activeView?: 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term'
  /** Whether the bottom panel was open. Absent → true. */
  panelOpen?: boolean
  /** Active bottom-panel tab. Absent → 'log'. */
  panelTab?: 'terminal' | 'log' | 'problems'
  /** Bottom-panel terminal tabs (names + cwd). Fresh shells on restore. */
  panelTerminals?: PanelTerminalTab[]
  /** Focused bottom-panel terminal tab id, or null. */
  activePanelTerminalId?: string | null
  /** Full-screen terminal sessions (names + split layout). Fresh shells. */
  termSessions?: TermSessionSnapshot[]
  /** Focused full-screen session id, or null. */
  activeTermSessionId?: string | null
```

- [ ] **Step 3: Extend `ProjectSessionSnapshot` with the same fields**

In `src/types/workspace.ts`, inside `interface ProjectSessionSnapshot`, add after `activeTabPath`:

```ts
  /** View that was foreground on close. Absent → 'ide'. */
  activeView?: 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term'
  /** Whether the bottom panel was open. Absent → true. */
  panelOpen?: boolean
  /** Active bottom-panel tab. Absent → 'log'. */
  panelTab?: 'terminal' | 'log' | 'problems'
  /** Bottom-panel terminal tabs (names + cwd). */
  panelTerminals?: PanelTerminalTab[]
  /** Focused bottom-panel terminal tab id, or null. */
  activePanelTerminalId?: string | null
  /** Full-screen terminal sessions (names + split layout). */
  termSessions?: TermSessionSnapshot[]
  /** Focused full-screen session id, or null. */
  activeTermSessionId?: string | null
```

- [ ] **Step 4: Bump the schema version**

In `src/types/workspace.ts`, change `interface PersistedState`'s `schemaVersion: 4;` to `schemaVersion: 5;`. Update the doc comment above `PersistedState` to add: `REQ-009 bumps from 4 → 5 to persist active view, bottom-panel state, and terminal tabs/sessions; v4 → v5 is shape-preserving (the new fields live inside the optional ProjectSession block).`

- [ ] **Step 5: Re-export pane types from paneTree instead of declaring them**

In `src/renderer/src/lib/paneTree.ts`, delete the local `export type SplitDir = ...` and `export type PaneNode = ...` declarations and replace them with a re-export at the top (keep the surrounding file comment):

```ts
import type { PaneNode, SplitDir } from '../../../types/workspace'

export type { PaneNode, SplitDir }
```

(Leave `Rect`, `PaneBox`, `DividerBox`, `Layout`, and all functions untouched — they keep importing `PaneNode`/`SplitDir` from the same module.)

- [ ] **Step 6: Typecheck + run the paneTree tests**

Run: `npx vitest run src/renderer/src/lib/paneTree.test.ts`
Expected: PASS (the re-export is structurally identical; no behavior change).

- [ ] **Step 7: Commit**

```bash
git add src/types/workspace.ts src/renderer/src/lib/paneTree.ts
git commit -m "feat(types): terminal-session persisted shapes + schema v5"
```

---

## Task 2: Migration v4 → v5

**Files:**
- Modify: `src/main/state/migrate.ts`
- Test: `src/main/state/migrate.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/state/migrate.test.ts`, add two cases (place them next to the existing "valid v4" block):

```ts
it('upgrades a v4 payload to v5, carrying all data, no backup', async () => {
  const v4 = {
    schemaVersion: 4,
    lastProjectId: 'p1',
    recents: [{ id: 'p1', name: 'Acme', repoCount: 1, lastOpenedAt: 10 }],
    projects: {
      p1: {
        id: 'p1',
        name: 'Acme',
        repos: [],
        createdAt: 1,
        lastOpenedAt: 2,
        expandedPaths: [],
        openTabs: [],
        activeTabPath: null,
      },
    },
    layout: { explorerWidth: 256, dockWidth: 344, panelHeight: 232 },
    enabledPlugins: { p1: ['a/b'] },
    window: { width: 1480, height: 920 },
  }
  vol.fromJSON({ 'workspace.json': JSON.stringify(v4) }, DIR)

  const result = migrate(v4, SOURCE_PATH)

  expect(result.schemaVersion).toBe(5)
  expect(result.lastProjectId).toBe('p1')
  expect(result.recents).toEqual(v4.recents)
  expect(result.projects).toEqual(v4.projects)
  expect(result.layout).toEqual(v4.layout)
  expect(result.enabledPlugins).toEqual(v4.enabledPlugins)
  expect(result.window).toEqual(v4.window)
  // No backup written for a shape-preserving upgrade.
  expect(existsSync(V0_BACKUP_PATH)).toBe(false)
})

it('passes a valid v5 payload through unchanged', async () => {
  const v5 = {
    schemaVersion: 5,
    lastProjectId: null,
    recents: [],
    projects: {},
    layout: { explorerWidth: 256, dockWidth: 344, panelHeight: 232 },
    enabledPlugins: {},
    window: { width: 1480, height: 920 },
  }
  vol.fromJSON({ 'workspace.json': JSON.stringify(v5) }, DIR)

  const result = migrate(v5, SOURCE_PATH)

  // Reference-equal pass-through (store.ts relies on this to skip a write).
  expect(result).toBe(v5)
})
```

Note: match the existing test file's helpers for the fs mock and constants. Inspect the top of `migrate.test.ts` for the exact names — it uses `vol.fromJSON(...)`, `SOURCE_PATH`, `V0_BACKUP_PATH`, `DIR`, and imports `existsSync`. If a helper name differs, use the file's actual name; do not invent new ones.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/state/migrate.test.ts`
Expected: FAIL — the v4→v5 test sees `schemaVersion: 4` (current `isValidV4` passes v4 through), and the v5 pass-through test fails because `isValidV5` doesn't exist yet so v5 falls to defaults.

- [ ] **Step 3: Update `defaults()` to v5**

In `src/main/state/migrate.ts`, change `defaults()`'s `schemaVersion: 4,` to `schemaVersion: 5,`.

- [ ] **Step 4: Add the v5 validator + v4→v5 upgrade, re-point the chain**

In `src/main/state/migrate.ts`:

Add a v4 structural shape helper and a v5 validator. Rename the existing `isValidV4` body into a shape check `hasV4Shape` (v3 shape + `enabledPlugins` validation) and express both validators on top of it:

```ts
/** Structural check for v4-and-up fields (v3 shape + enabledPlugins map). */
function hasV4Shape(raw: unknown): boolean {
  if (!hasV3Shape(raw)) return false
  const r = raw as Record<string, unknown>
  const ep = r.enabledPlugins
  if (ep === null || typeof ep !== 'object') return false
  for (const v of Object.values(ep as Record<string, unknown>)) {
    if (!Array.isArray(v)) return false
    if (!v.every((s) => typeof s === 'string')) return false
  }
  return true
}

/** A valid v4 payload (used only as an upgrade source now). */
function isValidV4(raw: unknown): raw is PersistedStateV4 {
  if (!hasV4Shape(raw)) return false
  return (raw as Record<string, unknown>).schemaVersion === 4
}

/** A valid v5 payload — v4 shape + version marker. */
function isValidV5(raw: unknown): raw is PersistedState {
  if (!hasV4Shape(raw)) return false
  return (raw as Record<string, unknown>).schemaVersion === 5
}
```

Add the v4 internal shape type next to `PersistedStateV3`:

```ts
/** Internal shape for a v4 payload — v3 fields + enabledPlugins. */
interface PersistedStateV4 {
  schemaVersion: 4
  lastProjectId: string | null
  recents: PersistedState['recents']
  projects: PersistedState['projects']
  layout: LayoutSnapshot
  enabledPlugins: PersistedState['enabledPlugins']
  window: PersistedState['window']
}
```

Add the upgrade function:

```ts
/** Shape-preserving v4 → v5: carry everything, bump the version marker. */
function upgradeV4ToV5(v4: PersistedStateV4): PersistedState {
  return {
    schemaVersion: 5,
    lastProjectId: v4.lastProjectId,
    recents: v4.recents,
    projects: v4.projects,
    layout: v4.layout,
    enabledPlugins: v4.enabledPlugins,
    window: v4.window,
  }
}
```

Update the v2/v3 upgrade functions to emit `schemaVersion: 5` (rename them to `upgradeV2ToV5` / `upgradeV3ToV5`, or just change the literal + return value — keep them terminating at v5). Their bodies stay the same except `schemaVersion: 5` and (v3) carrying `enabledPlugins` forward; (v2) filling `enabledPlugins: {}`.

Rewrite `migrate()`'s branch order:

```ts
export function migrate(raw: unknown, sourcePath?: string): PersistedState {
  if (isValidV5(raw)) return raw
  if (isValidV4(raw)) return upgradeV4ToV5(raw)
  if (isValidV3(raw)) return upgradeV3ToV5(raw)
  if (isValidV2(raw)) return upgradeV2ToV5(raw)
  if (isV1Shape(raw)) {
    if (sourcePath !== undefined) archiveExisting(sourcePath, V1_BACKUP_FILENAME)
    return defaults()
  }
  if (sourcePath !== undefined) archiveExisting(sourcePath, V0_BACKUP_FILENAME)
  return defaults()
}
```

Update the module-doc comment block at the top to describe the v5 policy.

- [ ] **Step 5: Update the existing v2/v3/v4 expectations in the test file**

In `src/main/state/migrate.test.ts`, any existing assertion of `schemaVersion).toBe(4)` for the v2 and v3 upgrade cases becomes `.toBe(5)`. The existing "valid v4 passes through unchanged / reference-equal" case must change: v4 is now upgraded, not passed through. Convert that case to assert v4 → v5 (the new Step-1 test already covers this richly — if the old reference-equal v4 case now contradicts it, delete the old one). The "future version 99" and "v1 archive" cases are unchanged.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/main/state/migrate.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/state/migrate.ts src/main/state/migrate.test.ts
git commit -m "feat(state): migrate workspace schema v4 → v5"
```

---

## Task 3: Store — UI-routing + terminal-mirror slices

**Files:**
- Modify: `src/renderer/src/store/workspaceStore.ts`
- Test: `src/renderer/src/store/workspaceStore.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/renderer/src/store/workspaceStore.test.ts`, add a block:

```ts
describe('ui-routing + terminal slices', () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState?.() ?? {})
  })

  it('has defaults', () => {
    const s = useWorkspaceStore.getState()
    expect(s.activeView).toBe('ide')
    expect(s.panelOpen).toBe(true)
    expect(s.panelTab).toBe('log')
    expect(s.panelTerminals).toEqual([])
    expect(s.activePanelTerminalId).toBeNull()
    expect(s.termSessions).toEqual([])
    expect(s.activeTermSessionId).toBeNull()
  })

  it('setters mutate', () => {
    const st = useWorkspaceStore.getState()
    st.setActiveView('term')
    st.setPanelOpen(false)
    st.setPanelTab('terminal')
    st.setPanelTerminals([{ tabId: 't1', title: 'build', cwd: '/x' }])
    st.setActivePanelTerminalId('t1')
    st.setTermSessions([
      {
        id: 's1',
        group: 'Local',
        title: 'logs',
        branch: '~',
        root: { type: 'pane', id: 'p1' },
        activePane: 'p1',
        panes: { p1: { title: 'logs', cwd: '/x', branch: '~' } },
      },
    ])
    st.setActiveTermSessionId('s1')
    const s = useWorkspaceStore.getState()
    expect(s.activeView).toBe('term')
    expect(s.panelOpen).toBe(false)
    expect(s.panelTab).toBe('terminal')
    expect(s.panelTerminals[0].title).toBe('build')
    expect(s.activePanelTerminalId).toBe('t1')
    expect(s.termSessions[0].title).toBe('logs')
    expect(s.activeTermSessionId).toBe('s1')
  })

  it('hydrateFromSession restores the new fields and falls back to defaults', () => {
    useWorkspaceStore.getState().hydrateFromSession({
      expandedPaths: [],
      openTabs: [],
      activeTabPath: null,
      activeView: 'scm',
      panelOpen: false,
      panelTab: 'terminal',
      panelTerminals: [{ tabId: 't9', title: 'tail', cwd: '/y' }],
      activePanelTerminalId: 't9',
      termSessions: [],
      activeTermSessionId: null,
    })
    let s = useWorkspaceStore.getState()
    expect(s.activeView).toBe('scm')
    expect(s.panelOpen).toBe(false)
    expect(s.panelTerminals[0].title).toBe('tail')

    // Absent fields fall back to defaults.
    useWorkspaceStore.getState().hydrateFromSession({
      expandedPaths: [],
      openTabs: [],
      activeTabPath: null,
    })
    s = useWorkspaceStore.getState()
    expect(s.activeView).toBe('ide')
    expect(s.panelOpen).toBe(true)
    expect(s.panelTab).toBe('log')
    expect(s.panelTerminals).toEqual([])
  })

  it('setProject resets the new fields to defaults', () => {
    const st = useWorkspaceStore.getState()
    st.setActiveView('term')
    st.setPanelTerminals([{ tabId: 't1', title: 'x' }])
    st.setProject(null)
    const s = useWorkspaceStore.getState()
    expect(s.activeView).toBe('ide')
    expect(s.panelTerminals).toEqual([])
    expect(s.activeTermSessionId).toBeNull()
  })
})
```

If the test file lacks a per-test reset, mirror its existing reset pattern instead of `getInitialState`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/store/workspaceStore.test.ts`
Expected: FAIL — `activeView` etc. undefined, setters not functions.

- [ ] **Step 3: Add the new types to `WorkspaceState`**

In `src/renderer/src/store/workspaceStore.ts`, add to the import block from `../../../types/workspace`:

```ts
  PanelTerminalTab,
  TermSessionSnapshot,
```

Add a local view alias near the top (matching `App.tsx`'s `ViewKey`):

```ts
/** Top-level views the workarea routes between (mirrors App.tsx ViewKey). */
export type WorkspaceView = 'ide' | 'hub' | 'prs' | 'plugins' | 'scm' | 'term'
/** Bottom-panel tab (mirrors BottomPanel.tsx BottomPanelTab). */
export type WorkspacePanelTab = 'terminal' | 'log' | 'problems'
```

Add to `interface WorkspaceState` (state section):

```ts
  // ----- ui routing + terminals (REQ-009) -------------------------------
  activeView: WorkspaceView
  panelOpen: boolean
  panelTab: WorkspacePanelTab
  panelTerminals: PanelTerminalTab[]
  activePanelTerminalId: string | null
  termSessions: TermSessionSnapshot[]
  activeTermSessionId: string | null
```

Add to `interface WorkspaceState` (actions section):

```ts
  setActiveView: (view: WorkspaceView) => void
  setPanelOpen: (open: boolean) => void
  setPanelTab: (tab: WorkspacePanelTab) => void
  setPanelTerminals: (tabs: PanelTerminalTab[]) => void
  setActivePanelTerminalId: (id: string | null) => void
  setTermSessions: (sessions: TermSessionSnapshot[]) => void
  setActiveTermSessionId: (id: string | null) => void
```

- [ ] **Step 4: Add defaults + a shared reset constant**

Define a reusable default object near `INITIAL_STATE` (above it):

```ts
/** Defaults for the UI-routing + terminal slices. Re-used on project swap. */
const UI_DEFAULTS = {
  activeView: 'ide' as WorkspaceView,
  panelOpen: true,
  panelTab: 'log' as WorkspacePanelTab,
  panelTerminals: [] as PanelTerminalTab[],
  activePanelTerminalId: null as string | null,
  termSessions: [] as TermSessionSnapshot[],
  activeTermSessionId: null as string | null,
}
```

Add these keys to the `INITIAL_STATE` `Pick<WorkspaceState, ...>` union and object: add `'activeView' | 'panelOpen' | 'panelTab' | 'panelTerminals' | 'activePanelTerminalId' | 'termSessions' | 'activeTermSessionId'` to the `Pick`, and spread `...UI_DEFAULTS` into the `INITIAL_STATE` object literal.

- [ ] **Step 5: Implement the setters**

In the `create<WorkspaceState>(...)` body, add:

```ts
  setActiveView: (view) =>
    set((s) => (s.activeView === view ? {} : { activeView: view })),
  setPanelOpen: (open) =>
    set((s) => (s.panelOpen === open ? {} : { panelOpen: open })),
  setPanelTab: (tab) =>
    set((s) => (s.panelTab === tab ? {} : { panelTab: tab })),
  setPanelTerminals: (tabs) => set(() => ({ panelTerminals: tabs })),
  setActivePanelTerminalId: (id) =>
    set((s) => (s.activePanelTerminalId === id ? {} : { activePanelTerminalId: id })),
  setTermSessions: (sessions) => set(() => ({ termSessions: sessions })),
  setActiveTermSessionId: (id) =>
    set((s) => (s.activeTermSessionId === id ? {} : { activeTermSessionId: id })),
```

- [ ] **Step 6: Restore in `hydrateFromSession`**

In `hydrateFromSession`, extend the returned object so it also restores the new fields with default fallbacks:

```ts
  hydrateFromSession: (snapshot) =>
    set(() => ({
      openTabs: snapshot.openTabs.map((t) => ({ ...t })),
      activeTabPath: snapshot.activeTabPath,
      expandedSet: new Set(snapshot.expandedPaths),
      dirtyMap: Object.fromEntries(
        snapshot.openTabs.filter((t) => t.dirty).map((t) => [t.path, true]),
      ),
      activeView: snapshot.activeView ?? UI_DEFAULTS.activeView,
      panelOpen: snapshot.panelOpen ?? UI_DEFAULTS.panelOpen,
      panelTab: snapshot.panelTab ?? UI_DEFAULTS.panelTab,
      panelTerminals: snapshot.panelTerminals ?? [],
      activePanelTerminalId: snapshot.activePanelTerminalId ?? null,
      termSessions: snapshot.termSessions ?? [],
      activeTermSessionId: snapshot.activeTermSessionId ?? null,
    })),
```

- [ ] **Step 7: Reset on project swap**

In `setProject`, `createProject`, and `closeProject`, add `...UI_DEFAULTS` to each returned/`set` state object (alongside the existing `openTabs: []`, `scm: {}`, etc.). This guarantees a clean slate when swapping projects; the subsequent `hydrateFromSession` (when a snapshot exists) fills the real values.

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run src/renderer/src/store/workspaceStore.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/store/workspaceStore.ts src/renderer/src/store/workspaceStore.test.ts
git commit -m "feat(store): ui-routing + terminal-mirror slices with restore/reset"
```

---

## Task 4: `InlineEditable` primitive

**Files:**
- Create: `src/renderer/src/components/primitives/InlineEditable.tsx`
- Test: `src/renderer/src/components/primitives/InlineEditable.test.tsx`
- Modify: `src/renderer/src/components/primitives/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/primitives/InlineEditable.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { InlineEditable } from './InlineEditable'

describe('InlineEditable', () => {
  it('shows the value as text until double-clicked', () => {
    render(<InlineEditable value="acme" onCommit={() => {}} />)
    expect(screen.getByText('acme')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('commits the trimmed value on Enter', () => {
    const onCommit = vi.fn()
    render(<InlineEditable value="acme" onCommit={onCommit} />)
    fireEvent.doubleClick(screen.getByText('acme'))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  payments  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('payments')
  })

  it('commits on blur', () => {
    const onCommit = vi.fn()
    render(<InlineEditable value="acme" onCommit={onCommit} />)
    fireEvent.doubleClick(screen.getByText('acme'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('renamed')
  })

  it('cancels on Escape without committing', () => {
    const onCommit = vi.fn()
    render(<InlineEditable value="acme" onCommit={onCommit} />)
    fireEvent.doubleClick(screen.getByText('acme'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByText('acme')).toBeTruthy()
  })

  it('ignores an empty commit', () => {
    const onCommit = vi.fn()
    render(<InlineEditable value="acme" onCommit={onCommit} />)
    fireEvent.doubleClick(screen.getByText('acme'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/components/primitives/InlineEditable.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `InlineEditable`**

Create `src/renderer/src/components/primitives/InlineEditable.tsx`:

```tsx
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type CSSProperties,
} from 'react'

export interface InlineEditableHandle {
  /** Enter edit mode programmatically (e.g. from a context menu). */
  startEditing: () => void
}

export interface InlineEditableProps {
  /** Current text. */
  value: string
  /** Called with the trimmed, non-empty new value on commit. */
  onCommit: (next: string) => void
  /** Optional className for the static text element. */
  className?: string
  /** Optional inline style for the static text element. */
  style?: CSSProperties
  /** Accessible label for the edit input. */
  ariaLabel?: string
}

/**
 * Renders `value` as text. Double-click (or an imperative `startEditing()`)
 * swaps it for a focused input. Enter / blur commit the trimmed value
 * (no-op when empty or unchanged); Escape cancels.
 */
export const InlineEditable = forwardRef<InlineEditableHandle, InlineEditableProps>(
  function InlineEditable({ value, onCommit, className, style, ariaLabel }, ref) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(value)
    const inputRef = useRef<HTMLInputElement | null>(null)

    useImperativeHandle(ref, () => ({
      startEditing: () => {
        setDraft(value)
        setEditing(true)
      },
    }))

    useEffect(() => {
      if (editing && inputRef.current) {
        inputRef.current.focus()
        inputRef.current.select()
      }
    }, [editing])

    function commit(): void {
      const trimmed = draft.trim()
      setEditing(false)
      if (trimmed !== '' && trimmed !== value) onCommit(trimmed)
    }

    function cancel(): void {
      setEditing(false)
      setDraft(value)
    }

    if (!editing) {
      return (
        <span
          className={className}
          style={style}
          onDoubleClick={() => {
            setDraft(value)
            setEditing(true)
          }}
        >
          {value}
        </span>
      )
    }

    return (
      <input
        ref={inputRef}
        className={className}
        style={style}
        aria-label={ariaLabel ?? 'Rename'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        onBlur={commit}
      />
    )
  },
)
```

- [ ] **Step 4: Export it**

In `src/renderer/src/components/primitives/index.ts`, add:

```ts
export { InlineEditable } from './InlineEditable'
export type { InlineEditableProps, InlineEditableHandle } from './InlineEditable'
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/renderer/src/components/primitives/InlineEditable.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/primitives/InlineEditable.tsx src/renderer/src/components/primitives/InlineEditable.test.tsx src/renderer/src/components/primitives/index.ts
git commit -m "feat(ui): InlineEditable primitive"
```

---

## Task 5: `ContextMenu` primitive

**Files:**
- Create: `src/renderer/src/components/primitives/ContextMenu.tsx`
- Test: `src/renderer/src/components/primitives/ContextMenu.test.tsx`
- Modify: `src/renderer/src/components/primitives/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/primitives/ContextMenu.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { ContextMenu } from './ContextMenu'

describe('ContextMenu', () => {
  it('renders items and fires onSelect, then closes', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <ContextMenu
        x={10}
        y={20}
        items={[{ label: 'Rename', onSelect }]}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByText('Rename'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on outside click without selecting', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const { container } = render(
      <ContextMenu
        x={0}
        y={0}
        items={[{ label: 'Rename', onSelect }]}
        onClose={onClose}
      />,
    )
    // The scrim is the first child.
    fireEvent.click(container.firstChild as Element)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/components/primitives/ContextMenu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ContextMenu`**

Create `src/renderer/src/components/primitives/ContextMenu.tsx`:

```tsx
export interface ContextMenuItem {
  label: string
  onSelect: () => void
}

export interface ContextMenuProps {
  /** Viewport x of the click that opened the menu. */
  x: number
  /** Viewport y of the click that opened the menu. */
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/**
 * A cursor-anchored popup menu. Reuses the existing `.menu` / `.menu-item`
 * styling. Renders a fixed full-viewport scrim behind the menu so any
 * outside click dismisses it.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 200 }}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="menu"
        style={{ position: 'fixed', left: x, top: y, zIndex: 201, minWidth: 160 }}
      >
        {items.map((it) => (
          <div
            key={it.label}
            className="menu-item"
            role="button"
            tabIndex={0}
            onClick={() => {
              it.onSelect()
              onClose()
            }}
          >
            <div className="mi-meta">
              <div className="mi-n">{it.label}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
```

- [ ] **Step 4: Export it**

In `src/renderer/src/components/primitives/index.ts`, add:

```ts
export { ContextMenu } from './ContextMenu'
export type { ContextMenuProps, ContextMenuItem } from './ContextMenu'
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/renderer/src/components/primitives/ContextMenu.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/primitives/ContextMenu.tsx src/renderer/src/components/primitives/ContextMenu.test.tsx src/renderer/src/components/primitives/index.ts
git commit -m "feat(ui): ContextMenu primitive"
```

---

## Task 6: App shell — route through the store + persist new fields

**Files:**
- Modify: `src/renderer/src/App.tsx`

This task has no new unit test (App.tsx has no existing test harness); verification is a typecheck + full suite + a manual smoke note. Keep each edit minimal.

- [ ] **Step 1: Replace local routing state with the store**

In `src/renderer/src/App.tsx`:

Remove these three `useState` lines:

```ts
const [view, setView] = useState<ViewKey>('ide')
const [panelOpen, setPanelOpen] = useState(true)
const [panelTab, setPanelTab] = useState<BottomPanelTab>('log')
```

Replace with store-backed values + setters:

```ts
const view = useWorkspaceStore((s) => s.activeView)
const setView = useWorkspaceStore((s) => s.setActiveView)
const panelOpen = useWorkspaceStore((s) => s.panelOpen)
const setPanelOpen = useWorkspaceStore((s) => s.setPanelOpen)
const panelTab = useWorkspaceStore((s) => s.panelTab)
const setPanelTab = useWorkspaceStore((s) => s.setPanelTab)
```

Note: `setPanelOpen` previously accepted a React updater (`(o) => !o`) in the ⌘J handler and the BottomPanel `onClose`. The store setter takes a plain boolean. Update those call sites:
- ⌘J handler: replace `setPanelOpen((o) => !o)` with `setPanelOpen(!useWorkspaceStore.getState().panelOpen)`.
- Any other `setPanelOpen((x) => ...)` updater form: convert to a plain boolean using the current store value.

`setView`/`setPanelTab` are already called with plain values throughout, so they need no change. The local `ViewKey` / `BottomPanelTab` type aliases in App.tsx stay (used in props); they structurally match the store's `WorkspaceView` / `WorkspacePanelTab`.

- [ ] **Step 2: Persist the new fields in `buildSnapshot`**

In `buildSnapshot`, inside the `if (s.project) { ... }` block, extend the `session` object with the new fields (read straight off `s`):

```ts
    const session: ProjectSession = {
      id: s.project.id,
      name: s.project.name,
      repos: s.project.repos,
      createdAt: s.project.createdAt,
      lastOpenedAt: s.project.lastOpenedAt,
      hiveWorkspacePath: s.project.hiveWorkspacePath,
      expandedPaths: Array.from(s.expandedSet),
      openTabs: s.openTabs.map((t: OpenTab) => ({
        path: t.path,
        viewState: t.viewState,
      })),
      activeTabPath: s.activeTabPath,
      activeView: s.activeView,
      panelOpen: s.panelOpen,
      panelTab: s.panelTab,
      panelTerminals: s.panelTerminals,
      activePanelTerminalId: s.activePanelTerminalId,
      termSessions: s.termSessions,
      activeTermSessionId: s.activeTermSessionId,
    }
```

Also change `buildSnapshot`'s returned `schemaVersion: 4` literal to `schemaVersion: 5`.

- [ ] **Step 3: Restore the new fields on boot + enterRecent**

In both the boot `hydrateFromSession(...)` call and the `enterRecent` `hydrateFromSession(...)` call, extend the snapshot argument:

```ts
        hydrateFromSession({
          expandedPaths: session.expandedPaths,
          openTabs: session.openTabs.map((t) => ({
            path: t.path,
            viewState: t.viewState,
            dirty: false,
          })),
          activeTabPath: session.activeTabPath,
          activeView: session.activeView,
          panelOpen: session.panelOpen,
          panelTab: session.panelTab,
          panelTerminals: session.panelTerminals,
          activePanelTerminalId: session.activePanelTerminalId,
          termSessions: session.termSessions,
          activeTermSessionId: session.activeTermSessionId,
        })
```

- [ ] **Step 4: Mount the full-screen terminal when restoring into it**

The existing effect already mounts the terminal when `view === 'term'`:

```ts
useEffect(() => {
  if (view === 'term') setTermMounted(true)
}, [view])
```

Because `view` now comes from the store and is set by `hydrateFromSession` during boot, this effect already fires on restore — no change needed. Verify it still reads `view` (the store value) and not a removed local.

- [ ] **Step 5: Make the title-bar project name renamable**

Locate the title-bar project switcher:

```tsx
<span className="pn">{project?.name ?? 'No project'}</span>
```

Replace with an `InlineEditable` when a project is open (keep the static fallback otherwise). Import `InlineEditable` from `./components/primitives` and grab the action:

```tsx
const renameProject = useWorkspaceStore((s) => s.renameProject)
```

Then:

```tsx
{project ? (
  <InlineEditable
    className="pn"
    value={project.name}
    ariaLabel="Rename project"
    onCommit={(next) => renameProject(project.id, next)}
  />
) : (
  <span className="pn">No project</span>
)}
```

Important: the parent `.proj-switch` has an `onClick={() => setProjMenu((m) => !m)}`. The `InlineEditable` input already calls `e.stopPropagation()` on click/double-click, so entering edit mode won't toggle the menu. Verify by reading the rendered structure; if the double-click still bubbles to open the menu, wrap the `InlineEditable` in a `<span onDoubleClick={(e) => e.stopPropagation()}>`.

- [ ] **Step 6: Typecheck + full suite**

Run: `npm test`
Expected: PASS (no App.tsx unit tests; this confirms nothing else regressed). Also run the TypeScript build check the repo uses if separate (`npx tsc -p tsconfig.web.json --noEmit` if present).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(app): route view/panel through store, persist + restore, title-bar rename"
```

---

## Task 7: Bottom-panel terminal — seed, mirror, rename

**Files:**
- Modify: `src/renderer/src/components/Terminal.tsx`

- [ ] **Step 1: Seed tab state from the store**

In `TerminalPanel`, import the store hooks at the top (already imports `useWorkspaceStore`). Read the persisted seed + mirror setters:

```ts
const persistedTerminals = useWorkspaceStore((s) => s.panelTerminals)
const persistedActiveId = useWorkspaceStore((s) => s.activePanelTerminalId)
const setPanelTerminals = useWorkspaceStore((s) => s.setPanelTerminals)
const setActivePanelTerminalId = useWorkspaceStore((s) => s.setActivePanelTerminalId)
```

Extend `TabEntry` to carry a per-tab cwd so restore can re-spawn in the right place:

```ts
interface TabEntry {
  tabId: string
  title: string
  cwd?: string
  ptyId: string | null
  exited: boolean
}
```

Change `newTabEntry()` to accept a cwd:

```ts
function newTabEntry(cwd?: string): TabEntry {
  return {
    tabId: `tab-${Date.now()}-${nextTabSeq}`,
    title: `Term ${nextTabSeq++}`,
    cwd,
    ptyId: null,
    exited: false,
  }
}
```

Initialise `tabs` from the persisted seed when present (read once via a lazy initializer that captures the store's first value — use `useState(() => ...)` reading `useWorkspaceStore.getState()` so it doesn't re-seed on every render):

```ts
const [tabs, setTabs] = useState<TabEntry[]>(() => {
  const seed = useWorkspaceStore.getState().panelTerminals
  if (seed.length > 0) {
    return seed.map((t) => ({
      tabId: t.tabId,
      title: t.title,
      cwd: t.cwd,
      ptyId: null,
      exited: false,
    }))
  }
  return [newTabEntry(cwd)]
})
const [activeTabId, setActiveTabId] = useState<string>(() => {
  const seededActive = useWorkspaceStore.getState().activePanelTerminalId
  return seededActive ?? tabs[0]?.tabId ?? ''
})
```

(`cwd` here is the existing `useMemo` over `project?.repos[0]?.path` — keep it; it's the default cwd for brand-new tabs.) When opening a brand-new tab, pass the project cwd: `const entry = newTabEntry(cwd)`.

- [ ] **Step 2: Mirror tab state back to the store**

Add an effect that pushes the serializable shape on any change:

```ts
useEffect(() => {
  setPanelTerminals(
    tabs.map((t) => ({ tabId: t.tabId, title: t.title, cwd: t.cwd })),
  )
}, [tabs, setPanelTerminals])

useEffect(() => {
  setActivePanelTerminalId(activeTabId === '' ? null : activeTabId)
}, [activeTabId, setActivePanelTerminalId])
```

- [ ] **Step 3: Add a rename action + wire the chip**

Add a rename handler in `TerminalPanel`:

```ts
const renameTab = (tabId: string, title: string): void => {
  setTabs((prev) =>
    prev.map((t) => (t.tabId === tabId ? { ...t, title } : t)),
  )
}
```

Pass it into `TermTabChip`:

```tsx
<TermTabChip
  key={t.tabId}
  entry={t}
  active={t.tabId === activeTabId}
  onSelect={() => setActiveTabId(t.tabId)}
  onClose={() => closeTab(t.tabId)}
  onRename={(title) => renameTab(t.tabId, title)}
/>
```

- [ ] **Step 4: Make the chip renamable (double-click + context menu)**

Rewrite `TermTabChip` to use `InlineEditable` + `ContextMenu`. Import them: `import { Icon, InlineEditable, ContextMenu, type InlineEditableHandle } from './primitives'`.

```tsx
interface TermTabChipProps {
  entry: TabEntry
  active: boolean
  onSelect: () => void
  onClose: () => void
  onRename: (title: string) => void
}

function TermTabChip({ entry, active, onSelect, onClose, onRename }: TermTabChipProps) {
  const editRef = useRef<InlineEditableHandle | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  return (
    <div
      className={'term-tab' + (active ? ' active' : '') + (entry.exited ? ' exited' : '')}
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <InlineEditable
        ref={editRef}
        className="term-tab-label"
        value={entry.title}
        ariaLabel="Rename terminal"
        onCommit={onRename}
      />
      <button
        type="button"
        className="term-tab-close"
        title="Close terminal"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <Icon name="x" size={11} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: 'Rename', onSelect: () => editRef.current?.startEditing() },
            { label: 'Close', onSelect: onClose },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
```

Add `useRef`, `useState` to the React import in this file if not already imported (they are — `useState`, `useRef` already used; confirm `useRef` is in the import list and add if missing).

- [ ] **Step 5: Spawn uses the per-tab cwd**

The `TerminalInstance` currently receives `cwd={cwd}` (the project-level memo). Change the call site to prefer the tab's own cwd so restored tabs spawn in their saved directory:

```tsx
<TerminalInstance
  key={t.tabId}
  entry={t}
  active={t.tabId === activeTabId}
  cwd={t.cwd ?? cwd}
  ...
/>
```

- [ ] **Step 6: Typecheck + full suite + manual smoke**

Run: `npm test`
Expected: PASS.

Manual smoke (note for the executor, not automated): open the app, rename a bottom-panel terminal tab by double-clicking, add a second tab, quit, relaunch → both tabs return with their names, fresh shells.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/Terminal.tsx
git commit -m "feat(terminal): renamable bottom-panel tabs, persisted across relaunch"
```

---

## Task 8: Full-screen terminal sessions — seed, mirror, rename

**Files:**
- Modify: `src/renderer/src/components/TerminalView.tsx`

- [ ] **Step 1: Seed sessions/panes/active from the store**

In `TerminalView`, import the store: `import { useWorkspaceStore } from '../store/workspaceStore'`. Read seed + setters:

```ts
const setTermSessions = useWorkspaceStore((s) => s.setTermSessions)
const setActiveTermSessionId = useWorkspaceStore((s) => s.setActiveTermSessionId)
```

Replace the `seedRef` initialisation so it prefers a persisted snapshot. Keep the existing single-session fallback. The persisted `TermSessionSnapshot[]` already matches the local `Session` shape **except** it has no live fields, and `panes` is `Record<id, TermPaneMeta>` where `TermPaneMeta = { title, cwd?, branch }` — the local `PaneMeta` adds `id` + optional `exited`. Reconstruct local state from the snapshot:

```ts
const seedRef = useRef<SeedState | null>(null)
if (!seedRef.current) {
  const persisted = useWorkspaceStore.getState().termSessions
  if (persisted.length > 0) {
    const sessions: Session[] = persisted.map((s) => ({
      id: s.id,
      group: s.group,
      title: s.title,
      branch: s.branch,
      root: s.root,
      activePane: s.activePane,
    }))
    const panes: Record<string, PaneMeta> = {}
    for (const s of persisted) {
      for (const [pid, m] of Object.entries(s.panes)) {
        panes[pid] = { id: pid, title: m.title, cwd: m.cwd, branch: m.branch }
      }
    }
    seedRef.current = { sessions, panes }
  } else {
    // ... existing single-session seed unchanged ...
  }
}
```

Initialise `activeId` from the persisted active id when present:

```ts
const [activeId, setActiveId] = useState<string>(() => {
  const persistedActive = useWorkspaceStore.getState().activeTermSessionId
  return persistedActive ?? seed.sessions[0].id
})
```

- [ ] **Step 2: Mirror sessions/panes/active back to the store**

Add an effect that serialises current state into `TermSessionSnapshot[]` and pushes it:

```ts
useEffect(() => {
  const snapshot = sessions.map((s) => {
    const ids = paneIds(s.root)
    const paneMap: Record<string, { title: string; cwd?: string; branch: string }> = {}
    for (const pid of ids) {
      const m = panes[pid]
      if (m) paneMap[pid] = { title: m.title, cwd: m.cwd, branch: m.branch }
    }
    return {
      id: s.id,
      group: s.group,
      title: s.title,
      branch: s.branch,
      root: s.root,
      activePane: s.activePane,
      panes: paneMap,
    }
  })
  setTermSessions(snapshot)
}, [sessions, panes, setTermSessions])

useEffect(() => {
  setActiveTermSessionId(activeId)
}, [activeId, setActiveTermSessionId])
```

- [ ] **Step 3: Add a session rename action**

Add to `TerminalView`:

```ts
const renameSession = useCallback((sessionId: string, title: string) => {
  setSessions((ss) =>
    ss.map((s) => (s.id === sessionId ? { ...s, title } : s)),
  )
}, [])
```

- [ ] **Step 4: Make the session row title renamable**

Import the primitives: `import { Icon, InlineEditable, ContextMenu, type InlineEditableHandle } from './primitives'`.

In the rail row render (the `.cc-sess` block), the title is currently:

```tsx
<div className="cc-sess-t">
  <span className="cc-star">✳</span> {s.title}
</div>
```

Replace the `{s.title}` with an `InlineEditable` and add a context menu. Because the row's outer `onClick` selects the session and `onKeyDown` handles Enter/Space, the `InlineEditable` input's `stopPropagation` (already built in) prevents those from interfering. Extract the row into a small `SessionRow` component to hold the per-row `editRef` + menu state cleanly:

```tsx
interface SessionRowProps {
  s: Session
  active: boolean
  paneCount: number
  onSelect: () => void
  onRename: (title: string) => void
}

function SessionRow({ s, active, paneCount, onSelect, onRename }: SessionRowProps) {
  const editRef = useRef<InlineEditableHandle | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <div
      className={'cc-sess' + (active ? ' active' : '')}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <span className="cc-sess-dot" />
      <div className="cc-sess-meta">
        <div className="cc-sess-t">
          <span className="cc-star">✳</span>{' '}
          <InlineEditable
            ref={editRef}
            value={s.title}
            ariaLabel="Rename session"
            onCommit={onRename}
          />
        </div>
        <div className="cc-sess-b">
          <Icon name="git-branch" size={11} /> {s.branch}
        </div>
      </div>
      {paneCount > 1 && (
        <span className="cc-sess-panes" title={`${paneCount} panes`}>
          {paneCount}
        </span>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: 'Rename', onSelect: () => editRef.current?.startEditing() }]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
```

Then in the rail list `items.map(...)`, replace the inline row JSX with:

```tsx
{items.map((s) => (
  <SessionRow
    key={s.id}
    s={s}
    active={s.id === activeId}
    paneCount={paneIds(s.root).length}
    onSelect={() => setActiveId(s.id)}
    onRename={(title) => renameSession(s.id, title)}
  />
))}
```

- [ ] **Step 5: Typecheck + full suite + manual smoke**

Run: `npm test`
Expected: PASS.

Manual smoke (note for executor): open the full-screen Terminal view, rename a session (double-click the title and via right-click → Rename), split a pane, switch to it, quit, relaunch into the Terminal view → sessions return with names + split layout, fresh shells.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/TerminalView.tsx
git commit -m "feat(terminal): renamable full-screen sessions, persisted across relaunch"
```

---

## Task 9: Project rows — renamable in the Projects hub

**Files:**
- Modify: `src/renderer/src/components/ProjectsHub.tsx`

- [ ] **Step 1: Wire rename into `ProjectRow`**

In `src/renderer/src/components/ProjectsHub.tsx`, import the primitives and the rename action. Update the `primitives` import to include `InlineEditable`, `ContextMenu`, and the handle type:

```ts
import { Btn, Icon, InlineEditable, ContextMenu, type InlineEditableHandle } from './primitives'
```

In `ProjectRow`, read the action and add ref + menu state:

```tsx
function ProjectRow({ recent, isCurrent, onEnter }: ProjectRowProps) {
  const renameProject = useWorkspaceStore((s) => s.renameProject)
  const editRef = useRef<InlineEditableHandle | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const enter = useCallback(() => onEnter?.(recent.id), [onEnter, recent.id])

  const repoLabel =
    recent.repoCount === 0
      ? 'No repos'
      : recent.repoCount === 1
        ? '1 repo'
        : `${recent.repoCount} repos`

  return (
    <div
      className={'prow data ptable-cols' + (isCurrent ? ' cur' : '')}
      onClick={enter}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          enter()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      title={`Open ${recent.name}`}
    >
      <div className="pc-name">
        <div className="nm">
          <InlineEditable
            ref={editRef}
            value={recent.name}
            ariaLabel="Rename project"
            onCommit={(next) => renameProject(recent.id, next)}
          />
        </div>
        <div className="sk">{repoLabel}</div>
      </div>
      <span className="pc-repos">
        <Icon name="folder-git-2" size={13} /> {recent.repoCount}
      </span>
      <span className="pc-act">{formatRelativeTime(recent.lastOpenedAt)}</span>
      <span className="pc-open">
        {isCurrent ? <span className="live">● open</span> : '—'}
      </span>
      <span className="pc-chev">
        <Icon name="chevron-right" size={16} />
      </span>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: 'Rename', onSelect: () => editRef.current?.startEditing() },
            { label: 'Open', onSelect: enter },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
```

Add `useRef`, `useState` to the React import at the top of the file if not already present (the file imports `useCallback, useEffect, useMemo, useState` — add `useRef`).

Note on persistence: `renameProject` updates `recents` (and the active `project` when ids match). The App-shell save subscription persists `recents`; the rename survives relaunch. No extra wiring needed.

- [ ] **Step 2: Typecheck + full suite + manual smoke**

Run: `npm test`
Expected: PASS (existing ProjectsHub behavior unchanged; rename is additive).

Manual smoke (note for executor): in the Projects hub, double-click a project name → rename; right-click → Rename. Confirm the row's open-on-click still works when NOT editing, and that clicking into the input does not navigate. Relaunch → renamed name persists.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/ProjectsHub.tsx
git commit -m "feat(projects): renamable project rows (inline + context menu)"
```

---

## Task 10: Full-suite verification + manual end-to-end

**Files:** none (verification only).

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`
Expected: PASS, no skips introduced by this work.

- [ ] **Step 2: Typecheck the whole project**

Run the repo's build/typecheck. If `package.json` has a `build` or `typecheck` script, run it; otherwise `npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit`.
Expected: no type errors.

- [ ] **Step 3: Manual end-to-end (documented, run by the executor)**

Launch the app (`npm run dev` or the repo's run script). Verify, in order:
1. Rename a project (hub row, both double-click + right-click) and the title-bar name.
2. Open two editor files, expand some folders.
3. Open the bottom panel, rename a terminal tab, add a second tab.
4. Open the full-screen Terminal view, rename a session, split a pane.
5. Switch the active view to Source Control, then back to Terminal.
6. Quit and relaunch.
7. Confirm: same project open with its new name; same files open at the same scroll/cursor; same expanded folders; bottom-panel terminal tabs back with names (fresh shells); full-screen sessions back with names + split layout; the app reopens on the view you left (Terminal).

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for renamable names + session restore"
```

(Skip if nothing changed.)

---

## Notes for the executor

- **Do not resurrect live shells.** Restored terminals start fresh processes in their saved cwd. That is the intended behavior, documented in the spec's non-goals.
- **`stopPropagation` matters.** Every renamable surface sits inside a click-to-activate parent. The `InlineEditable` input stops click/double-click/keydown propagation so editing never triggers navigation. If a surface still navigates while editing, check that the parent isn't intercepting on a phase the input doesn't cover.
- **Mirror effects are write-only.** The terminal components own their live state; the store mirror exists solely so `buildSnapshot` can read a serializable copy. Never feed the store value back into the components after the initial seed (that would fight the component's own state on every keystroke).
