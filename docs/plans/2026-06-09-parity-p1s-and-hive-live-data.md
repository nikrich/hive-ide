# Parity P1s + Hive Live Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three P1 gaps from the verified parity audit (hunk-level staging UI, per-match replace opt-out, LSP-backed workspace symbols + find-references) and replace the remaining hive-panel seed data with real file-derived data (file-backed chat, PRs derived from story `prUrl`), removing the dead seed arrays.

**Architecture:** Each feature extends an existing, tested primitive: hunk staging reuses `buildHunkPatch` + the `git apply --cached` IPC; replace opt-out adds a line-exclusion mode to `replaceInFiles`; symbols/references add `workspace/symbol` and `textDocument/references` calls over the existing renderer-side LSP clients; chat mirrors the `events.ndjson` tail-reader pattern with a new `chat.ndjson`; PRs are a pure adapter over the live `HiveSnapshot`.

**Tech Stack:** TypeScript, Electron (main + preload + React renderer), Monaco, zustand, vscode-jsonrpc / vscode-languageserver-protocol, Vitest (+ happy-dom & RTL for components).

**Worktree:** `/Users/jannik/development/nikrich/hive-ide/.claude/worktrees/feat-parity-p1s-hive-data` (branch `worktree-feat-parity-p1s-hive-data`, based on latest `origin/main`). All paths below are relative to this root. Baseline: 736 tests / 76 files green, `npm run typecheck` clean.

---

## File Structure

- Modify `src/main/search/engine.ts` (+ `engine.test.ts`) — `excludeLines` replace mode.
- Modify `src/preload/api.ts`, `src/preload/index.ts` — replace payload passthrough; chat bridge.
- Modify `src/renderer/src/components/SearchView.tsx` (+ new `SearchView.test.tsx`) — match/file checkboxes.
- Create `src/renderer/src/components/DiffHunkBar.tsx` (+ test) — hunk strip; modify `src/renderer/src/components/Editor.tsx` (DiffTabHost).
- Modify `src/renderer/src/lib/lspClient.ts` — export client accessors; widen capabilities.
- Create `src/renderer/src/lib/lspWorkspaceSymbols.ts` (+ test); modify `src/renderer/src/lib/workspaceSymbols.ts`.
- Modify `src/renderer/src/lib/references.ts` (+ new `references.lsp.test.ts` helpers test).
- Modify `src/types/hive.ts`, `src/main/hive/parse.ts` (+ test), `src/main/hive/reader.ts`, `src/main/hive/handlers.ts`; create `src/main/hive/chat.ts` (+ test) — chat backend.
- Modify `src/renderer/src/lib/useHiveSession.ts`, `src/renderer/src/lib/hiveView.ts` (+ test), `src/renderer/src/components/AgentDock.tsx`, `src/renderer/src/App.tsx` — chat frontend.
- Modify `src/renderer/src/components/PRsView.tsx`, `src/renderer/src/lib/hiveView.ts`, `src/renderer/src/App.tsx` — live PR cards + route.
- Modify `src/renderer/src/data/seed.ts`; delete `src/renderer/src/components/MockDataRibbon.tsx` — cleanup.

Run all commands from the worktree root. Single-file test runs: `npx vitest run <path>`.

---

## Task 1: Replace engine — line-exclusion mode

**Files:**
- Modify: `src/main/search/engine.ts` (`ReplaceRequest` ~line 172, `replaceInFiles` ~line 191)
- Test: `src/main/search/engine.test.ts`

- [ ] **Step 1: Write the failing tests**

`engine.test.ts` already creates a tmpdir per test (`beforeEach` writes files under `root`). Follow that pattern and add:

```typescript
describe('replaceInFiles excludeLines', () => {
  it('skips excluded lines and replaces the rest', async () => {
    const file = join(root, 'ex.txt')
    await fs.writeFile(file, 'foo\nfoo\nfoo\n', 'utf8')
    const res = await replaceInFiles({
      files: [file],
      query: 'foo',
      replacement: 'bar',
      excludeLines: { [file]: [2] },
    })
    expect(res).toEqual({ filesChanged: 1, replacements: 2 })
    expect(await fs.readFile(file, 'utf8')).toBe('bar\nfoo\nbar\n')
  })

  it('counts multiple matches on a kept line and skips excluded ones', async () => {
    const file = join(root, 'multi.txt')
    await fs.writeFile(file, 'foo foo\nfoo\n', 'utf8')
    const res = await replaceInFiles({
      files: [file],
      query: 'foo',
      replacement: 'bar',
      excludeLines: { [file]: [2] },
    })
    expect(res).toEqual({ filesChanged: 1, replacements: 2 })
    expect(await fs.readFile(file, 'utf8')).toBe('bar bar\nfoo\n')
  })

  it('reports no change when every line is excluded', async () => {
    const file = join(root, 'all.txt')
    await fs.writeFile(file, 'foo\n', 'utf8')
    const res = await replaceInFiles({
      files: [file],
      query: 'foo',
      replacement: 'bar',
      excludeLines: { [file]: [1] },
    })
    expect(res).toEqual({ filesChanged: 0, replacements: 0 })
    expect(await fs.readFile(file, 'utf8')).toBe('foo\n')
  })

  it('regex backreferences still expand in line mode', async () => {
    const file = join(root, 're.txt')
    await fs.writeFile(file, 'name: a\nname: b\n', 'utf8')
    const res = await replaceInFiles({
      files: [file],
      query: 'name: (\\w+)',
      replacement: 'id=$1',
      options: { regex: true },
      excludeLines: { [file]: [2] },
    })
    expect(res.replacements).toBe(1)
    expect(await fs.readFile(file, 'utf8')).toBe('id=a\nname: b\n')
  })
})
```

(Import `replaceInFiles` if the file does not already.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/search/engine.test.ts -t excludeLines`
Expected: FAIL — type error / all lines replaced (no `excludeLines` field).

- [ ] **Step 3: Implement**

In `engine.ts`, extend the interface:

```typescript
export interface ReplaceRequest {
  /** Files to apply the replacement in (absolute paths). */
  files: string[]
  query: string
  replacement: string
  options?: SearchOptions
  /**
   * Per-file 1-based line numbers to SKIP (per-match opt-out, E2-04).
   * Files without an entry are replaced whole-file as before.
   */
  excludeLines?: Record<string, number[]>
}
```

In `replaceInFiles`, inside the `for (const file of req.files)` loop, after the `looksBinary` check, branch:

```typescript
    const excluded = req.excludeLines?.[file]
    const text = buf.toString('utf8')
    const re = buildReplaceRegExp(req.query, req.options)
    let next: string
    let count = 0
    if (excluded !== undefined && excluded.length > 0) {
      // Line-exclusion mode: replace line-by-line, skipping excluded lines.
      // Search matches are found per-line, so per-line replacement is
      // consistent with what the results pane showed.
      const skip = new Set(excluded)
      const lines = text.split('\n')
      next = lines
        .map((lineText, i) => {
          if (skip.has(i + 1)) return lineText
          re.lastIndex = 0
          const found = lineText.match(re)
          if (found === null) return lineText
          count += found.length
          re.lastIndex = 0
          return useRegex
            ? lineText.replace(re, req.replacement)
            : lineText.replace(re, () => req.replacement)
        })
        .join('\n')
    } else {
      const found = text.match(re)
      count = found ? found.length : 0
      if (count === 0) continue
      next = useRegex
        ? text.replace(re, req.replacement)
        : text.replace(re, () => req.replacement)
    }
    if (count > 0 && next !== text) {
      await fs.writeFile(file, next, 'utf8')
      filesChanged++
      replacements += count
    }
```

(This replaces the existing body from `const text = buf.toString('utf8')` down to the `if (next !== text)` block. Keep the surrounding read/binary-skip logic untouched.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/search/engine.test.ts`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/main/search/engine.ts src/main/search/engine.test.ts
git commit -m "feat(search): line-exclusion mode in replaceInFiles"
```

---

## Task 2: Replace opt-out — bridge + SearchView checkboxes

**Files:**
- Modify: `src/preload/api.ts` (`HiveSearchBridge.replace`, ~line 584-598)
- Modify: `src/preload/index.ts` (the `search.replace` passthrough)
- Modify: `src/renderer/src/components/SearchView.tsx`
- Test: `src/renderer/src/components/SearchView.test.tsx` (new)

- [ ] **Step 1: Extend the bridge contract**

In `src/preload/api.ts`, add to the `replace` request object type:

```typescript
    excludeLines?: Record<string, number[]>
```

In `src/preload/index.ts`, find the `search` bridge's `replace:` passthrough; it forwards the whole request object — confirm it sends the full `req` (e.g. `replace: (req) => ipcRenderer.invoke(SEARCH.replace, req)`). If it destructures fields, add `excludeLines` to the forwarded payload. Also check `src/main/search/handlers.ts`: the replace handler forwards its payload to `replaceInFiles` — if it rebuilds the object field-by-field, add `excludeLines`; if it passes the payload through, no change.

- [ ] **Step 2: Write the failing component test**

Create `src/renderer/src/components/SearchView.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import SearchView from './SearchView'
import { useWorkspaceStore } from '../store/workspaceStore'

const filesMock = vi.fn()
const replaceMock = vi.fn()

const RESULT = {
  results: [
    {
      file: '/repo/a.ts',
      matches: [
        { line: 1, preview: 'foo one', ranges: [{ start: 0, end: 3 }] },
        { line: 5, preview: 'foo five', ranges: [{ start: 0, end: 3 }] },
      ],
    },
    {
      file: '/repo/b.ts',
      matches: [{ line: 2, preview: 'foo two', ranges: [{ start: 0, end: 3 }] }],
    },
  ],
  truncated: false,
  total: 3,
}

beforeEach(() => {
  vi.useFakeTimers()
  filesMock.mockResolvedValue(RESULT)
  replaceMock.mockResolvedValue({ filesChanged: 2, replacements: 2 })
  ;(window as unknown as { hive: unknown }).hive = {
    search: { files: filesMock, replace: replaceMock, listFiles: vi.fn() },
  }
  useWorkspaceStore.setState({
    repos: [{ path: '/repo', name: 'repo' }] as never,
  })
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

async function searchFor(query: string): Promise<void> {
  render(<SearchView />)
  fireEvent.change(screen.getByLabelText('Search query'), {
    target: { value: query },
  })
  await vi.advanceTimersByTimeAsync(300)
  await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0))
}

describe('SearchView per-match opt-out', () => {
  it('renders a checkbox per match row and per file, all checked', async () => {
    await searchFor('foo')
    // 3 match rows + 2 file rows
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes).toHaveLength(5)
    expect(boxes.every((b) => b.checked)).toBe(true)
  })

  it('unchecking a match sends it as an excluded line', async () => {
    await searchFor('foo')
    fireEvent.click(screen.getByLabelText('Include match /repo/a.ts:5'))
    fireEvent.click(screen.getByLabelText('Toggle replace'))
    fireEvent.click(screen.getByLabelText('Replace all'))
    await vi.runAllTimersAsync()
    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        files: ['/repo/a.ts', '/repo/b.ts'],
        excludeLines: { '/repo/a.ts': [5] },
      }),
    )
  })

  it('unchecking a file excludes the whole file from the request', async () => {
    await searchFor('foo')
    fireEvent.click(screen.getByLabelText('Include file /repo/a.ts'))
    fireEvent.click(screen.getByLabelText('Toggle replace'))
    fireEvent.click(screen.getByLabelText('Replace all'))
    await vi.runAllTimersAsync()
    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ files: ['/repo/b.ts'] }),
    )
    const payload = replaceMock.mock.calls[0][0] as { excludeLines?: unknown }
    expect(payload.excludeLines ?? {}).toEqual({})
  })
})
```

Adjust store seeding if `useWorkspaceStore.setState({ repos })` needs more required fields — seed the minimum that makes `SearchView` render (it reads `repos`, `revealInFile`, and settings store `search.exclude`; `revealInFile` can be left as the store default, and the settings store default is fine).

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/renderer/src/components/SearchView.test.tsx`
Expected: FAIL — no checkboxes rendered.

- [ ] **Step 4: Implement in SearchView**

Add state + helpers after the `collapsed` state:

```typescript
  // Per-match opt-out (E2-04): keys are `${file}\n${line}` — \n is safe in
  // both POSIX and Windows paths, unlike ':'.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const matchKey = (file: string, line: number): string => `${file}\n${line}`

  const toggleMatch = (file: string, line: number): void =>
    setExcluded((prev) => {
      const next = new Set(prev)
      const key = matchKey(file, line)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const toggleFile = (group: SearchFileResult): void =>
    setExcluded((prev) => {
      const next = new Set(prev)
      const keys = group.matches.map((m) => matchKey(group.file, m.line))
      const allExcluded = keys.every((k) => next.has(k))
      for (const k of keys) {
        if (allExcluded) next.delete(k)
        else next.add(k)
      }
      return next
    })
```

Clear stale exclusions whenever a fresh result lands: in the debounced-search `.then((res) => { ... })`, add `setExcluded(new Set())` next to `setResult(res)` (and in `applyReplaceAll` after `setResult(fresh)`).

Rework `applyReplaceAll`'s request build:

```typescript
    const excludeLines: Record<string, number[]> = {}
    const files: string[] = []
    for (const group of result.results) {
      const skipped = group.matches
        .map((m) => m.line)
        .filter((line) => excluded.has(matchKey(group.file, line)))
      if (skipped.length === group.matches.length) continue // whole file opted out
      files.push(group.file)
      if (skipped.length > 0) excludeLines[group.file] = skipped
    }
    if (files.length === 0) return
    const res = await bridge.replace({
      files,
      query,
      replacement,
      options: opts,
      ...(Object.keys(excludeLines).length > 0 ? { excludeLines } : {}),
    })
```

In the file row (inside `srch-filerow`, before the chevron `Icon`), add a checkbox. Note the row has an `onClick` collapse handler — stop propagation:

```tsx
                <input
                  type="checkbox"
                  className="srch-include"
                  aria-label={`Include file ${group.file}`}
                  checked={!group.matches.every((m) => excluded.has(matchKey(group.file, m.line)))}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleFile(group)}
                />
```

In the match row (inside the `srch-matchrow` div, before `srch-lineno`), same idea:

```tsx
                      <input
                        type="checkbox"
                        className="srch-include"
                        aria-label={`Include match ${group.file}:${m.line}`}
                        checked={!excluded.has(matchKey(group.file, m.line))}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleMatch(group.file, m.line)}
                      />
```

Only render the checkboxes when `showReplace` is true (VSCode shows dismiss affordances in replace mode; this also keeps plain search uncluttered): wrap both in `{showReplace && (...)}`.

**Test note:** the test expects checkboxes without toggling replace first for the first assertion — so instead render them always. Drop the `showReplace` gating (keep it simple: always render). If visual clutter is a concern it can be styled smaller via the `srch-include` class later.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/renderer/src/components/SearchView.test.tsx && npx vitest run src/main/search`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/preload/api.ts src/preload/index.ts src/main/search/handlers.ts src/renderer/src/components/SearchView.tsx src/renderer/src/components/SearchView.test.tsx
git commit -m "feat(search): per-match and per-file opt-out for replace-in-files"
```

---

## Task 3: Hunk-level stage/unstage in the diff view

**Files:**
- Create: `src/renderer/src/components/DiffHunkBar.tsx`
- Test: `src/renderer/src/components/DiffHunkBar.test.tsx`
- Modify: `src/renderer/src/components/Editor.tsx` (DiffTabHost, ~line 735-827)

- [ ] **Step 1: Write the failing component test**

Create `src/renderer/src/components/DiffHunkBar.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DiffHunkBar } from './DiffHunkBar'
import type { DiffHunk } from '../lib/diffHunks'

afterEach(cleanup)

const HUNKS: DiffHunk[] = [
  { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, header: '@@ -1,2 +1,3 @@', lines: [' a', '+b', ' c'] },
  { oldStart: 9, oldLines: 1, newStart: 10, newLines: 1, header: '@@ -9 +10 @@', lines: ['-x', '+y'] },
]

describe('DiffHunkBar', () => {
  it('renders one action per hunk with stage labels', () => {
    const onApply = vi.fn()
    render(<DiffHunkBar hunks={HUNKS} mode="stage" busyIndex={null} onApply={onApply} />)
    const buttons = screen.getAllByRole('button', { name: /stage hunk/i })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(onApply).toHaveBeenCalledWith(1)
  })

  it('uses unstage labels in unstage mode and disables while busy', () => {
    render(<DiffHunkBar hunks={HUNKS} mode="unstage" busyIndex={0} onApply={vi.fn()} />)
    const buttons = screen.getAllByRole('button', { name: /unstage hunk/i })
    expect(buttons).toHaveLength(2)
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders nothing when there are no hunks', () => {
    const { container } = render(
      <DiffHunkBar hunks={[]} mode="stage" busyIndex={null} onApply={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/components/DiffHunkBar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DiffHunkBar**

Create `src/renderer/src/components/DiffHunkBar.tsx`:

```tsx
/**
 * Hunk action strip for diff tabs (E7-02).
 *
 * Renders one row per parsed diff hunk with a Stage/Unstage action. The host
 * (DiffTabHost) owns the git side effects; this component is presentational
 * so it stays unit-testable without IPC.
 */

import type { ReactElement } from 'react'

import type { DiffHunk } from '../lib/diffHunks'
import { Icon } from './primitives'

export interface DiffHunkBarProps {
  hunks: DiffHunk[]
  /** 'stage' on working-tree diffs, 'unstage' on index diffs. */
  mode: 'stage' | 'unstage'
  /** Index of the hunk currently being applied, or null when idle. */
  busyIndex: number | null
  onApply: (index: number) => void
}

export function DiffHunkBar({ hunks, mode, busyIndex, onApply }: DiffHunkBarProps): ReactElement | null {
  if (hunks.length === 0) return null
  const verb = mode === 'stage' ? 'Stage' : 'Unstage'
  return (
    <div className="hunkbar" role="toolbar" aria-label="Diff hunks">
      {hunks.map((h, i) => {
        const adds = h.lines.filter((l) => l.startsWith('+')).length
        const dels = h.lines.filter((l) => l.startsWith('-')).length
        return (
          <div key={`${h.header}-${i}`} className="hunkbar-row">
            <span className="hunkbar-meta meta-mono">
              {h.header.replace(/@@/g, '').trim()}
              {'  '}
              <span style={{ color: 'var(--diff-add-fg)' }}>+{adds}</span>{' '}
              <span style={{ color: 'var(--diff-del-fg)' }}>−{dels}</span>
            </span>
            <button
              type="button"
              className="srch-opt"
              disabled={busyIndex !== null}
              aria-label={`${verb} hunk ${i + 1}`}
              title={`${verb} this hunk`}
              onClick={() => onApply(i)}
            >
              <Icon name={mode === 'stage' ? 'plus' : 'minus'} size={13} />
              {busyIndex === i ? `${verb.replace(/e$/, '')}ing…` : `${verb} hunk`}
            </button>
          </div>
        )
      })}
    </div>
  )
}
```

Add minimal styles to `src/renderer/src/styles/ide.css` (append at the end; follow the file's var-based conventions):

```css
/* E7-02 — hunk staging strip on diff tabs */
.hunkbar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-raised);
  max-height: 96px;
  overflow-y: auto;
}
.hunkbar-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.hunkbar-meta {
  color: var(--fg-3);
}
.hunkbar .srch-opt {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
```

(If `ide.css` is not where sibling view styles live, put the block in the stylesheet that defines `.srch-opt` — grep for `.srch-opt {`.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/src/components/DiffHunkBar.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into DiffTabHost**

In `src/renderer/src/components/Editor.tsx`:

Add imports:

```typescript
import { DiffHunkBar } from './DiffHunkBar'
import { buildHunkPatch, parseHunks, type DiffHunk } from '../lib/diffHunks'
```

In `DiffTabHost`, add state:

```typescript
  const [hunks, setHunks] = useState<DiffHunk[]>([])
  const [busyHunk, setBusyHunk] = useState<number | null>(null)
```

In the existing `load()` effect, alongside the two side fetches, fetch and parse the diff (the same `ref` semantics: `head` = unstaged hunks, `index` = staged hunks):

```typescript
        const diffPromise = window.hive.git
          .diff(meta.repoPath, meta.path, meta.ref)
          .catch(() => '')
        const [left, right, diffText] = await Promise.all([
          leftPromise,
          rightPromise,
          diffPromise,
        ])
        if (cancelled) return
        setOriginal(left)
        setModified(right)
        setHunks(parseHunks(diffText))
```

Add a `reload` trigger so applying a hunk refreshes both sides + hunks. Simplest: lift the loader into a `useCallback` keyed by a `reloadToken` state, or add `const [reloadToken, setReloadToken] = useState(0)` to the effect deps and call `setReloadToken((t) => t + 1)` after staging.

Add the apply handler:

```typescript
  const applyHunk = async (index: number): Promise<void> => {
    const hunk = hunks[index]
    if (hunk === undefined) return
    setBusyHunk(index)
    try {
      const patch = buildHunkPatch(meta.path, hunk)
      await window.hive.git.applyPatch(meta.repoPath, patch, {
        cached: true,
        // On the index view the hunk is already staged — reverse it out.
        reverse: meta.ref === 'index',
      })
      await useWorkspaceStore.getState().fetchScm(meta.repoPath)
      setReloadToken((t) => t + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyHunk(null)
    }
  }
```

Render the bar above the diff (in the final return):

```tsx
  return (
    <>
      <DiffHunkBar
        hunks={hunks}
        mode={meta.ref === 'index' ? 'unstage' : 'stage'}
        busyIndex={busyHunk}
        onApply={(i) => void applyHunk(i)}
      />
      <DiffView
        ...existing props...
      />
    </>
  )
```

Wrap in a flex column if the diff editor loses height — the existing `.editor` section is a column flex; if the DiffEditor collapses, wrap both in `<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>` with the DiffView side wrapped in `<div style={{ flex: 1, minHeight: 0 }}>`.

**Gotcha:** `meta.path` is the repo-relative porcelain path (always `/`-separated) — exactly what `buildHunkPatch` expects.

- [ ] **Step 6: Full check + commit**

Run: `npm run typecheck && npx vitest run src/renderer/src/components/`
Expected: PASS.

```bash
git add src/renderer/src/components/DiffHunkBar.tsx src/renderer/src/components/DiffHunkBar.test.tsx src/renderer/src/components/Editor.tsx src/renderer/src/styles/ide.css
git commit -m "feat(scm): per-hunk stage/unstage strip on diff tabs"
```

---

## Task 4: LSP client — exported accessors + wider capabilities

**Files:**
- Modify: `src/renderer/src/lib/lspClient.ts`

- [ ] **Step 1: Export the accessors**

In `lspClient.ts` (~line 790) change `function findClientForLanguage` to `export function findClientForLanguage` and add below it:

```typescript
/** All currently-connected LSP clients (one per plugin:language). */
export function getActiveLspClients(): ActiveClient[] {
  return [...clients.values()]
}
```

Export the client type too (consumers need the shape): change `interface ActiveClient` (~line 96) to `export interface ActiveClient`.

- [ ] **Step 2: Advertise the new capabilities**

In `clientCapabilities()` (~line 508), add to `textDocument`:

```typescript
      references: { dynamicRegistration: false },
```

and add a sibling `workspace` key next to `textDocument`:

```typescript
    workspace: {
      symbol: { dynamicRegistration: false },
    },
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && npx vitest run src/renderer/src/lib/lspClient.test.ts`
Expected: PASS.

```bash
git add src/renderer/src/lib/lspClient.ts
git commit -m "feat(lsp): export client accessors + advertise references/workspace-symbol capabilities"
```

---

## Task 5: LSP-backed workspace symbols (⌘T)

**Files:**
- Create: `src/renderer/src/lib/lspWorkspaceSymbols.ts`
- Test: `src/renderer/src/lib/lspWorkspaceSymbols.test.ts`
- Modify: `src/renderer/src/lib/workspaceSymbols.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/lspWorkspaceSymbols.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'

import {
  fileUriToPath,
  lspSymbolKindName,
  queryLspWorkspaceSymbols,
  type LspSymbolClient,
} from './lspWorkspaceSymbols'

function client(
  result: unknown,
  capabilities: Record<string, unknown> = { workspaceSymbolProvider: true },
): LspSymbolClient {
  return {
    language: 'python',
    capabilities,
    connection: { sendRequest: vi.fn().mockResolvedValue(result) },
  }
}

describe('fileUriToPath', () => {
  it('decodes a posix file uri', () => {
    expect(fileUriToPath('file:///home/u/a%20b.py')).toBe('/home/u/a b.py')
  })
  it('decodes a windows file uri', () => {
    expect(fileUriToPath('file:///C:/proj/x.py')).toBe('C:/proj/x.py')
  })
  it('passes through non-file uris unchanged', () => {
    expect(fileUriToPath('untitled:Untitled-1')).toBe('untitled:Untitled-1')
  })
})

describe('queryLspWorkspaceSymbols', () => {
  it('maps SymbolInformation results to WorkspaceSymbol', async () => {
    const c = client([
      {
        name: 'do_thing',
        kind: 12,
        containerName: 'mod',
        location: {
          uri: 'file:///proj/mod.py',
          range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } },
        },
      },
    ])
    const out = await queryLspWorkspaceSymbols([c], 'do')
    expect(out).toEqual([
      {
        name: 'do_thing',
        kind: 'function',
        containerName: 'mod',
        path: '/proj/mod.py',
        line: 5,
        column: 3,
      },
    ])
  })

  it('skips clients whose server lacks workspaceSymbolProvider', async () => {
    const c = client([], {})
    const out = await queryLspWorkspaceSymbols([c], 'x')
    expect(out).toEqual([])
    expect(c.connection.sendRequest).not.toHaveBeenCalled()
  })

  it('survives a rejecting client', async () => {
    const bad: LspSymbolClient = {
      language: 'go',
      capabilities: { workspaceSymbolProvider: true },
      connection: { sendRequest: vi.fn().mockRejectedValue(new Error('boom')) },
    }
    const good = client([
      {
        name: 'ok',
        kind: 5,
        location: { uri: 'file:///p/a.go', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } },
      },
    ])
    const out = await queryLspWorkspaceSymbols([bad, good], 'o')
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('class')
  })
})

describe('lspSymbolKindName', () => {
  it('falls back to "symbol" for unknown kinds', () => {
    expect(lspSymbolKindName(999)).toBe('symbol')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/lib/lspWorkspaceSymbols.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/renderer/src/lib/lspWorkspaceSymbols.ts`:

```typescript
/**
 * Plugin-LSP `workspace/symbol` querying (generalizes ⌘T beyond TS/JS).
 *
 * Fans the query out to every connected LSP client whose server advertises
 * `workspaceSymbolProvider`, then maps LSP SymbolInformation / WorkspaceSymbol
 * results into the palette's `WorkspaceSymbol` shape. Pure data-in/data-out
 * over an injected minimal client shape, so it unit-tests without IPC.
 */

import type { WorkspaceSymbol } from './workspaceSymbols'

/** The slice of an ActiveClient this module needs (kept minimal for tests). */
export interface LspSymbolClient {
  language: string
  capabilities: Record<string, unknown> | null
  connection: {
    sendRequest: (type: unknown, params: unknown) => Promise<unknown>
  }
}

/** LSP SymbolKind (1-26) → human-readable kind names. */
const KIND_NAMES: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class',
  6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum',
  11: 'interface', 12: 'function', 13: 'variable', 14: 'constant',
  15: 'string', 16: 'number', 17: 'boolean', 18: 'array', 19: 'object',
  20: 'key', 21: 'null', 22: 'enum member', 23: 'struct', 24: 'event',
  25: 'operator', 26: 'type parameter',
}

export function lspSymbolKindName(kind: number): string {
  return KIND_NAMES[kind] ?? 'symbol'
}

/** `file://` URI → filesystem path (posix + windows). Non-file URIs pass through. */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  let rest = decodeURIComponent(uri.slice('file://'.length))
  // file:///C:/x → /C:/x → C:/x
  if (/^\/[a-zA-Z]:/.test(rest)) rest = rest.slice(1)
  return rest
}

interface LspSymbolLike {
  name?: unknown
  kind?: unknown
  containerName?: unknown
  location?: { uri?: unknown; range?: { start?: { line?: unknown; character?: unknown } } }
}

export async function queryLspWorkspaceSymbols(
  lspClients: LspSymbolClient[],
  query: string,
  max = 200,
): Promise<WorkspaceSymbol[]> {
  const eligible = lspClients.filter(
    (c) => c.capabilities?.workspaceSymbolProvider !== undefined
      && c.capabilities?.workspaceSymbolProvider !== false,
  )
  const settled = await Promise.allSettled(
    eligible.map((c) =>
      c.connection.sendRequest('workspace/symbol', { query }),
    ),
  )
  const out: WorkspaceSymbol[] = []
  for (const res of settled) {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue
    for (const raw of res.value as LspSymbolLike[]) {
      if (typeof raw?.name !== 'string') continue
      const uri = raw.location?.uri
      const start = raw.location?.range?.start
      if (typeof uri !== 'string') continue
      out.push({
        name: raw.name,
        kind: lspSymbolKindName(typeof raw.kind === 'number' ? raw.kind : -1),
        containerName: typeof raw.containerName === 'string' ? raw.containerName : '',
        path: fileUriToPath(uri),
        line: (typeof start?.line === 'number' ? start.line : 0) + 1,
        column: (typeof start?.character === 'number' ? start.character : 0) + 1,
      })
      if (out.length >= max) return out
    }
  }
  return out
}
```

Note: `sendRequest('workspace/symbol', …)` — vscode-jsonrpc accepts a string method name; this avoids importing the protocol type and keeps `LspSymbolClient` minimal. (`WorkspaceSymbol` results that use `location: { uri }` without a range still produce line/column 1 — acceptable.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/src/lib/lspWorkspaceSymbols.test.ts`
Expected: PASS.

- [ ] **Step 5: Merge into `queryWorkspaceSymbols`**

In `src/renderer/src/lib/workspaceSymbols.ts`, import:

```typescript
import { getActiveLspClients } from './lspClient'
import { queryLspWorkspaceSymbols, type LspSymbolClient } from './lspWorkspaceSymbols'
```

Restructure `queryWorkspaceSymbols` so the TS-worker part becomes a helper and both sources merge. Replace the body with:

```typescript
export async function queryWorkspaceSymbols(
  query: string,
  max = 200,
): Promise<WorkspaceSymbol[]> {
  if (query.trim() === '') return []
  const [ts, lsp] = await Promise.all([
    queryTsWorkspaceSymbols(query, max),
    queryLspWorkspaceSymbols(
      getActiveLspClients() as unknown as LspSymbolClient[],
      query,
      max,
    ).catch(() => []),
  ])
  // De-dupe on path:line:name (TS worker wins on ties).
  const seen = new Set(ts.map((s) => `${s.path}:${s.line}:${s.name}`))
  const merged = [...ts]
  for (const s of lsp) {
    const key = `${s.path}:${s.line}:${s.name}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(s)
  }
  return merged.slice(0, max)
}
```

and rename the existing implementation to `async function queryTsWorkspaceSymbols(query: string, max: number): Promise<WorkspaceSymbol[]>` (same body as today, including the early `monaco === null` return).

The `as unknown as LspSymbolClient[]` cast bridges `ActiveClient.capabilities` (a structured LSP type) to the minimal record shape — fine at this boundary.

Also update the file's header comment (it currently says plugin-LSP `workspace/symbol` "would extend it once exposed" — now it does).

- [ ] **Step 6: Full check + commit**

Run: `npm run typecheck && npx vitest run src/renderer/src/lib/`
Expected: PASS.

```bash
git add src/renderer/src/lib/lspWorkspaceSymbols.ts src/renderer/src/lib/lspWorkspaceSymbols.test.ts src/renderer/src/lib/workspaceSymbols.ts
git commit -m "feat(lsp): workspace-symbol search queries plugin LSP servers (⌘T beyond TS/JS)"
```

---

## Task 6: LSP-backed find-references (⇧F12)

**Files:**
- Modify: `src/renderer/src/lib/references.ts`
- Test: `src/renderer/src/lib/references.test.ts` (new — tests the pure converter)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/references.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { lspLocationsToHits } from './references'

describe('lspLocationsToHits', () => {
  it('maps LSP locations to reference hits with previews from open models', () => {
    const models = [
      {
        uri: { toString: () => 'file:///p/a.py', fsPath: '/p/a.py' },
        getLineContent: (n: number) => (n === 3 ? '  total = add(a, b)' : ''),
      },
    ]
    const hits = lspLocationsToHits(
      [
        {
          uri: 'file:///p/a.py',
          range: { start: { line: 2, character: 10 }, end: { line: 2, character: 13 } },
        },
        {
          uri: 'file:///p/b.py',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        },
      ],
      models as never,
    )
    expect(hits).toEqual([
      { path: '/p/a.py', line: 3, column: 11, preview: 'total = add(a, b)' },
      { path: '/p/b.py', line: 1, column: 1, preview: '' },
    ])
  })

  it('returns [] for null/undefined responses', () => {
    expect(lspLocationsToHits(null, [] as never)).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/lib/references.test.ts`
Expected: FAIL — `lspLocationsToHits` not exported.

- [ ] **Step 3: Implement**

In `src/renderer/src/lib/references.ts`:

Add imports:

```typescript
import { findClientForLanguage } from './lspClient'
import { fileUriToPath } from './lspWorkspaceSymbols'
```

Add the pure converter (export it for the test):

```typescript
interface LspLocationLike {
  uri?: unknown
  range?: { start?: { line?: unknown; character?: unknown } }
}

interface ModelLike {
  uri: { toString(): string; fsPath: string }
  getLineContent(line: number): string
}

/** LSP Location[] → ReferenceHit[], previewing from open Monaco models. */
export function lspLocationsToHits(
  locations: unknown,
  models: readonly ModelLike[],
): ReferenceHit[] {
  if (!Array.isArray(locations)) return []
  const hits: ReferenceHit[] = []
  for (const raw of locations as LspLocationLike[]) {
    if (typeof raw?.uri !== 'string') continue
    const start = raw.range?.start
    const line = (typeof start?.line === 'number' ? start.line : 0) + 1
    const column = (typeof start?.character === 'number' ? start.character : 0) + 1
    const model = models.find((m) => m.uri.toString() === raw.uri) ?? null
    let preview = ''
    if (model !== null) {
      try {
        preview = model.getLineContent(line).trim()
      } catch {
        preview = ''
      }
    }
    hits.push({ path: model ? model.uri.fsPath : fileUriToPath(raw.uri), line, column, preview })
  }
  return hits
}
```

Then generalize `queryReferences`: replace the early-return language guard with a branch. The TS/JS path stays as-is; non-TS models with a connected LSP client go through `textDocument/references`:

```typescript
  const model = ed.getModel()
  const pos = ed.getPosition()
  if (!model || !pos) return { symbol: '', hits: [] }
  const symbol = model.getWordAtPosition(pos)?.word ?? ''

  if (!/typescript|javascript/.test(model.getLanguageId())) {
    const client = findClientForLanguage(model.getLanguageId())
    if (client === null) return { symbol, hits: [] }
    try {
      const result = await client.connection.sendRequest('textDocument/references', {
        textDocument: { uri: model.uri.toString() },
        position: { line: pos.lineNumber - 1, character: pos.column - 1 },
        context: { includeDeclaration: true },
      })
      return { symbol, hits: lspLocationsToHits(result, monaco.editor.getModels()) }
    } catch {
      return { symbol, hits: [] }
    }
  }
  // …existing TS-worker path unchanged below (move the existing
  // `const offset = …` / try-block here)…
```

Note `client.connection.sendRequest(method: string, params)` is the vscode-jsonrpc string-method overload — same approach as Task 5. Update the file header comment to mention the LSP path.

- [ ] **Step 4: Run + commit**

Run: `npm run typecheck && npx vitest run src/renderer/src/lib/references.test.ts`
Expected: PASS.

```bash
git add src/renderer/src/lib/references.ts src/renderer/src/lib/references.test.ts
git commit -m "feat(lsp): find-references queries plugin LSP servers for non-TS languages"
```

---

## Task 7: Hive chat — backend (file-backed `chat.ndjson`)

**Files:**
- Modify: `src/types/hive.ts`
- Modify: `src/main/hive/parse.ts` + `src/main/hive/parse.test.ts`
- Create: `src/main/hive/chat.ts` + `src/main/hive/chat.test.ts`
- Modify: `src/main/hive/reader.ts`
- Modify: `src/main/hive/handlers.ts`

- [ ] **Step 1: Add the type**

In `src/types/hive.ts`, after `HiveEvent` (~line 93):

```typescript
/** One operator/manager chat message — a line of `.hive/chat.ndjson`. */
export interface HiveChatMessage {
  ts: string;
  /** 'you' = the operator; otherwise the speaking agent's role. */
  who: 'you' | HiveRole;
  txt: string;
}
```

Extend `HiveSessionBundle`:

```typescript
export interface HiveSessionBundle {
  connection: HiveConnection;
  snapshot: HiveSnapshot;
  events: HiveEvent[];
  chat: HiveChatMessage[];
}
```

- [ ] **Step 2: Failing parse test**

Look at `src/main/hive/parse.test.ts` for the `parseEventLine` describe block and add a sibling:

```typescript
describe('parseChatLine', () => {
  it('parses a valid chat line', () => {
    expect(
      parseChatLine('{"ts":"2026-06-09T10:00:00Z","who":"you","txt":"hi"}'),
    ).toEqual({ ts: '2026-06-09T10:00:00Z', who: 'you', txt: 'hi' })
  })

  it('coerces unknown roles to manager', () => {
    expect(
      parseChatLine('{"ts":"t","who":"alien","txt":"x"}'),
    ).toEqual({ ts: 't', who: 'manager', txt: 'x' })
  })

  it('accepts agent roles', () => {
    expect(parseChatLine('{"ts":"t","who":"tech-lead","txt":"x"}')?.who).toBe('tech-lead')
  })

  it('rejects blank, malformed, and missing-text lines', () => {
    expect(parseChatLine('')).toBeNull()
    expect(parseChatLine('not json')).toBeNull()
    expect(parseChatLine('{"ts":"t","who":"you"}')).toBeNull()
  })
})
```

Run: `npx vitest run src/main/hive/parse.test.ts -t parseChatLine` → FAIL (not exported).

- [ ] **Step 3: Implement `parseChatLine`**

In `src/main/hive/parse.ts`, mirror `parseEventLine`'s defensive style (read that function first and match it):

```typescript
import { HIVE_ROLES, type HiveChatMessage } from '../../types/hive';

/** Parse one `chat.ndjson` line. Returns null for blank/malformed lines. */
export function parseChatLine(line: string): HiveChatMessage | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.txt !== 'string' || r.txt === '') return null;
  const who =
    r.who === 'you' || (HIVE_ROLES as readonly string[]).includes(r.who as string)
      ? (r.who as HiveChatMessage['who'])
      : 'manager';
  return {
    ts: typeof r.ts === 'string' ? r.ts : '',
    who,
    txt: r.txt,
  };
}
```

(Adjust imports to the file's existing import block; `HIVE_ROLES` may already be imported.)

Run: `npx vitest run src/main/hive/parse.test.ts` → PASS.

- [ ] **Step 4: Failing append test**

Create `src/main/hive/chat.test.ts`:

```typescript
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendChatMessage } from './chat';

let ws: string;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'hive-chat-'));
  await mkdir(join(ws, '.hive'), { recursive: true });
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('appendChatMessage', () => {
  it('appends one ndjson line per call', async () => {
    await appendChatMessage(ws, 'first', new Date('2026-06-09T10:00:00Z'));
    await appendChatMessage(ws, 'second', new Date('2026-06-09T10:01:00Z'));
    const lines = (await readFile(join(ws, '.hive', 'chat.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { ts: '2026-06-09T10:00:00.000Z', who: 'you', txt: 'first' },
      { ts: '2026-06-09T10:01:00.000Z', who: 'you', txt: 'second' },
    ]);
  });

  it('rejects empty messages', async () => {
    await expect(appendChatMessage(ws, '   ')).rejects.toThrow(/empty/i);
  });
});
```

Run: `npx vitest run src/main/hive/chat.test.ts` → FAIL (module not found).

- [ ] **Step 5: Implement `appendChatMessage`**

Create `src/main/hive/chat.ts`:

```typescript
/**
 * Operator chat persistence — `.hive/chat.ndjson` (one JSON message per line).
 *
 * The operator's messages are APPENDED here by the IDE; the manager process
 * appends its replies to the same file. The hive reader tails the file and
 * pushes new messages to the renderer — files stay the single source of truth
 * (no in-memory chat state in main).
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { HiveChatMessage } from '../../types/hive';

/** Append one operator message. Creates the file on first write. */
export async function appendChatMessage(
  workspacePath: string,
  text: string,
  now: Date = new Date(),
): Promise<void> {
  const txt = text.trim();
  if (txt === '') throw new Error('chat: message is empty');
  const msg: HiveChatMessage = { ts: now.toISOString(), who: 'you', txt };
  await fs.appendFile(
    join(workspacePath, '.hive', 'chat.ndjson'),
    `${JSON.stringify(msg)}\n`,
    'utf8',
  );
}
```

Run: `npx vitest run src/main/hive/chat.test.ts` → PASS.

- [ ] **Step 6: Tail the chat file in the reader**

In `src/main/hive/reader.ts`, mirror the events tail exactly:

- Add to `HIVE_EVENTS`: `chat: 'event:hive:chat',`.
- Add fields: `#chat: HiveChatMessage[] = [];` and `#chatBytes = 0;` (import the type).
- Add `#chatFile(): string { return join(this.#workspacePath as string, '.hive', 'chat.ndjson'); }`.
- In `setWorkspace`: reset `this.#chat = []; this.#chatBytes = 0;`, and after `#reloadEvents(true, gen)` add `await this.#reloadChat(true, gen);`.
- In `bundle()`: add `chat: this.#chat,`.
- In `#startWatcher`: add `join(path, '.hive', 'chat.ndjson')` to the watched array.
- In `#scheduleReload`'s timeout: chain `.then(() => this.#reloadChat(false, gen))`.
- Add `#reloadChat` — a copy of `#reloadEvents` with `eventsFile→chatFile`, `#eventBytes→#chatBytes`, `#events→#chat`, `parseEventLine→parseChatLine`, and the send channel `HIVE_EVENTS.chat`. Import `parseChatLine` from `./parse`.

- [ ] **Step 7: The send handler**

In `src/main/hive/handlers.ts`:

- Add to `HIVE_CHANNELS`: `sendChat: 'ipc:hive:chat:send',`.
- Register:

```typescript
  ipcMain.handle(HIVE_CHANNELS.sendChat, async (_e, text: string): Promise<void> => {
    const ws = hiveReader.workspacePath();
    if (ws === null) throw new Error('hive: no workspace connected');
    if (typeof text !== 'string') throw new TypeError('hive: chat text must be a string');
    await appendChatMessage(ws, text);
  });
```

- Import `appendChatMessage` from `./chat`; add `ipcMain.removeHandler(HIVE_CHANNELS.sendChat);` to the teardown return.

- [ ] **Step 8: Fix the bundle type fallout**

`HiveSessionBundle` gained `chat` — typecheck will flag every literal bundle. Known spots: `reader.ts#bundle()` (done above) and any tests constructing bundles. Run `npm run typecheck` and fix each by adding `chat: []` (or real data).

- [ ] **Step 9: Full check + commit**

Run: `npm run typecheck && npx vitest run src/main/hive/`
Expected: PASS.

```bash
git add src/types/hive.ts src/main/hive/parse.ts src/main/hive/parse.test.ts src/main/hive/chat.ts src/main/hive/chat.test.ts src/main/hive/reader.ts src/main/hive/handlers.ts
git commit -m "feat(hive): file-backed chat — chat.ndjson tail + send handler"
```

---

## Task 8: Hive chat — preload bridge + frontend

**Files:**
- Modify: `src/preload/api.ts`, `src/preload/index.ts`
- Modify: `src/renderer/src/lib/useHiveSession.ts`
- Modify: `src/renderer/src/lib/hiveView.ts` + `src/renderer/src/lib/hiveView.test.ts`
- Modify: `src/renderer/src/components/AgentDock.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Preload bridge**

`src/preload/api.ts` — extend `HiveOrchestrationBridge`:

```typescript
  /** Append an operator message to `.hive/chat.ndjson`. */
  sendChat(text: string): Promise<void>;
  onChat(handler: (msgs: import('../types/hive').HiveChatMessage[]) => void): Unsubscribe;
```

`src/preload/index.ts` — the `HIVE` channel map needs `sendChat: 'ipc:hive:chat:send'` and `evtChat: 'event:hive:chat'` (match the existing `evtSnapshot`/`evtEvents` naming). In the `orchestration` bridge object add:

```typescript
    sendChat: (text: string) => ipcRenderer.invoke(HIVE.sendChat, text),
    onChat: (handler: (msgs: HiveChatMessage[]) => void): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, m: HiveChatMessage[]): void => handler(m);
      ipcRenderer.on(HIVE.evtChat, listener);
      return () => ipcRenderer.removeListener(HIVE.evtChat, listener);
    },
```

(Import `HiveChatMessage` alongside the other hive type imports.)

**Push-shape note:** the reader sends the *fresh tail* (`HiveChatMessage[]` of new messages), same as events.

- [ ] **Step 2: Session store**

In `src/renderer/src/lib/useHiveSession.ts`:

- Add `chat: HiveChatMessage[]` to state (+ import), default `[]`.
- Add `appendChat: (m: HiveChatMessage[]) => void` mirroring `appendEvents` (with the same `MAX_TAIL` slice).
- `reset` gains a `chat` param: `reset: (c, s, e, chat) => set({ connection, snapshot, events, chat })` — update the call site to pass `bundle.chat`.
- In the subscription effect add `bridge.onChat((m) => store.appendChat(m))` to the `unsubs` array.

- [ ] **Step 3: Adapter + test**

`src/renderer/src/lib/hiveView.test.ts` — add (match the file's existing import style):

```typescript
describe('toChatMsgs', () => {
  it('maps operator and role messages to panel ChatMsg shape', () => {
    expect(
      toChatMsgs([
        { ts: 't1', who: 'you', txt: 'hello' },
        { ts: 't2', who: 'tech-lead', txt: 'on it' },
      ]),
    ).toEqual([
      { who: 'you', txt: 'hello' },
      { who: 'techlead', role: 'techlead', txt: 'on it' },
    ])
  })
})
```

Run to see it fail, then add to `hiveView.ts`:

```typescript
import type { HiveChatMessage } from '../../../types/hive'
import type { ChatMsg } from '../data/seed'

/** Native chat messages → the Dock ChatPanel's seed-shaped ChatMsg. */
export function toChatMsgs(msgs: readonly HiveChatMessage[]): ChatMsg[] {
  return msgs.map((m): ChatMsg => {
    if (m.who === 'you') return { who: 'you', txt: m.txt }
    const key = roleKey(m.who)
    return { who: key, role: key, txt: m.txt }
  })
}
```

(Fold the type imports into the existing import statements.) Run: `npx vitest run src/renderer/src/lib/hiveView.test.ts` → PASS.

- [ ] **Step 4: ChatPanel goes controlled**

In `src/renderer/src/components/AgentDock.tsx`:

- Delete `MANAGER_REPLY` and `MANAGER_REPLY_DELAY_MS`.
- `ChatPanelProps` becomes `{ chat: ChatMsg[]; onSend: (text: string) => void }`.
- Remove the local `msgs` state; render `chat` directly (`chat.map(...)`); the scroll effect depends on `[chat]`.
- `send()` becomes:

```typescript
  function send(): void {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }
```

- Empty state: when `chat.length === 0`, render `<div className="chat-empty">No messages yet — talk to the manager below.</div>` inside the scroll area (add a tiny `.chat-empty { color: var(--fg-3); font: var(--t-body-sm); padding: 12px; }` rule next to the other chat styles if none fits).
- `DockProps` gains `onSendChat: (text: string) => void`; `Dock` destructures it and renders `<ChatPanel chat={chat} onSend={onSendChat} />`.
- Update the file-header comment (no more simulated reply).

- [ ] **Step 5: App wiring**

In `src/renderer/src/App.tsx`:

- Remove `chat` from the seed import (line 101): `import { problems } from './data/seed'` → it becomes unused too after Task 10; for now just drop `chat`.
- Add live chat selectors near the other hive selectors (~line 263):

```typescript
  const hiveChat = useHiveSessionStore((s) => s.chat)
  const liveChat = useMemo(() => toChatMsgs(hiveChat), [hiveChat])
  const onSendChat = useCallback((text: string) => {
    void window.hive?.orchestration?.sendChat(text).catch((e) => {
      notify('warning', e instanceof Error ? e.message : String(e))
    })
  }, [])
```

(`notify` is already imported in App or import from `./store/notificationsStore` — check; `toChatMsgs` joins the existing `hiveView` import.)

- Thread props: `IdeLayout` gets `liveChat={liveChat}` and `onSendChat={onSendChat}` (add to its props interface where `liveBoard` etc. are declared), and inside `IdeLayout` the `<Dock … chat={liveChat} onSendChat={onSendChat} />` replaces `chat={chat}`.

- [ ] **Step 6: Full check + commit**

Run: `npm run typecheck && npx vitest run src/renderer/src/lib/hiveView.test.ts && npx vitest run src/renderer/src/components/`
Expected: PASS.

```bash
git add src/preload/api.ts src/preload/index.ts src/renderer/src/lib/useHiveSession.ts src/renderer/src/lib/hiveView.ts src/renderer/src/lib/hiveView.test.ts src/renderer/src/components/AgentDock.tsx src/renderer/src/App.tsx
git commit -m "feat(hive): live file-backed chat in the Dock (no simulated replies)"
```

---

## Task 9: PRs view — derive cards from story `prUrl`

**Files:**
- Modify: `src/renderer/src/lib/hiveView.ts` + `src/renderer/src/lib/hiveView.test.ts`
- Modify: `src/renderer/src/components/PRsView.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Failing adapter test**

Add to `hiveView.test.ts` (reuse the file's story-fixture helper if one exists; otherwise build minimal `HiveStory` literals — all required fields: `id,title,status,role,points,team,dependsOn,acceptanceCriteria,createdAt,updatedAt,body`):

```typescript
describe('toPrCards', () => {
  const base = {
    points: 3, team: 'web', dependsOn: [], acceptanceCriteria: [],
    createdAt: '2026-06-09T08:00:00Z', body: '',
  }
  it('derives cards from stories with a prUrl, newest first', () => {
    const cards = toPrCards(
      [
        { ...base, id: 'S1', title: 'A', status: 'review', role: 'senior', prUrl: 'https://github.com/o/r/pull/12', featureBranch: 'feat/a', updatedAt: '2026-06-09T10:00:00Z' },
        { ...base, id: 'S2', title: 'B', status: 'merged', role: 'tech-lead', prUrl: 'https://github.com/o/r/pull/15', featureBranch: 'feat/b', updatedAt: '2026-06-09T11:00:00Z', mergedAt: '2026-06-09T11:00:00Z' },
        { ...base, id: 'S3', title: 'C', status: 'in-progress', role: 'junior', updatedAt: '2026-06-09T09:00:00Z' },
      ],
      new Date('2026-06-09T12:00:00Z'),
    )
    expect(cards.map((c) => c.num)).toEqual([15, 12])
    expect(cards[0]).toEqual({
      storyId: 'S2', num: 15, title: 'B', role: 'techlead',
      branch: 'feat/b', status: 'merged', url: 'https://github.com/o/r/pull/15',
      time: '1h ago',
    })
    expect(cards[1].status).toBe('review')
  })

  it('handles unparsable PR numbers and missing branches', () => {
    const [card] = toPrCards(
      [{ ...base, id: 'S4', title: 'D', status: 'review', role: 'qa', prUrl: 'https://example.com/x', updatedAt: '2026-06-09T11:59:30Z' }],
      new Date('2026-06-09T12:00:00Z'),
    )
    expect(card.num).toBeNull()
    expect(card.branch).toBe('')
    expect(card.time).toBe('just now')
  })
})
```

Run: `npx vitest run src/renderer/src/lib/hiveView.test.ts -t toPrCards` → FAIL.

- [ ] **Step 2: Implement the adapter**

Add to `hiveView.ts`:

```typescript
export interface PrCard {
  storyId: string
  /** PR number parsed from the URL tail, or null when unparsable. */
  num: number | null
  title: string
  role: RoleKey
  branch: string
  status: 'review' | 'merged'
  url: string
  /** Relative age, e.g. `12m ago`. */
  time: string
}

/** Coarse relative-age formatter (`just now` / `Nm ago` / `Nh ago` / `Nd ago`). */
function timeAgo(iso: string, now: Date): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((now.getTime() - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Stories carrying a `prUrl` → PR cards, newest activity first. */
export function toPrCards(
  stories: readonly HiveStory[],
  now: Date = new Date(),
): PrCard[] {
  return stories
    .filter((s): s is HiveStory & { prUrl: string } => typeof s.prUrl === 'string' && s.prUrl !== '')
    .sort((a, b) => (b.mergedAt ?? b.updatedAt).localeCompare(a.mergedAt ?? a.updatedAt))
    .map((s): PrCard => {
      const numMatch = /\/(\d+)\/?$/.exec(s.prUrl)
      return {
        storyId: s.id,
        num: numMatch ? Number(numMatch[1]) : null,
        title: s.title,
        role: roleKey(s.role),
        branch: s.featureBranch ?? '',
        status: s.status === 'merged' ? 'merged' : 'review',
        url: s.prUrl,
        time: timeAgo(s.mergedAt ?? s.updatedAt, now),
      }
    })
}
```

Run the test → PASS.

- [ ] **Step 3: Rework PRsView**

Rewrite `src/renderer/src/components/PRsView.tsx` to consume `PrCard[]`:

- Props:

```typescript
export interface PRsViewProps {
  prs: PrCard[]
  /** Eyebrow label — the active project name. */
  projectLabel: string
}
```

- Remove the seed import (`ROLE` stays — it still lives in `data/seed.ts`; import `type PrCard` from `../lib/hiveView`).
- Keep `PR_ICON` keyed by `PrCard['status']` (same two keys). Delete `CHECKS_COLOR` / `CHECKS_ICON` and the add/del/checks spans (no real data for them).
- Row changes: `key={pr.storyId}`, number renders as `{pr.num !== null ? `#${pr.num}` : pr.storyId}`, branch chip renders only when `pr.branch !== ''`.
- Replace the header "Open on GitHub" `Btn` with nothing (each row gets its own action).
- Add a per-row action button in the right column:

```tsx
                <Btn
                  kind="outline"
                  sm
                  icon="external-link"
                  onClick={() => void window.hive?.shell?.openExternal(pr.url)}
                >
                  Open
                </Btn>
```

(Check `Btn`'s prop surface in `./primitives` — if `sm`/`onClick` aren't supported props, follow the nearest existing usage, e.g. in AgentDock.)
- Empty state before the map:

```tsx
        {prs.length === 0 && (
          <div className="srch-status">
            No pull requests yet — they appear here when hive stories carry a PR URL.
          </div>
        )}
```

- Update the header sub-copy and the file header comment; use `projectLabel` for the eyebrow (drop `HIVE_PROJECT_LABEL`).

- [ ] **Step 4: Route it in App**

In `src/renderer/src/App.tsx`:

- Import: `import { PRsView } from './components/PRsView'` and add `toPrCards` to the `hiveView` import.
- Live cards memo next to the other adapters: `const livePrs = useMemo(() => toPrCards(hiveSnapshot.stories), [hiveSnapshot.stories])`.
- Render route (next to the `view === 'search'` line):

```tsx
          {!showWelcomeOnly && view === 'prs' && (
            <PRsView prs={livePrs} projectLabel={project?.name ?? ''} />
          )}
```

- Confirm navigation: grep for an existing rail entry or palette command targeting `'prs'` (`grep -n "prs" src/renderer/src/App.tsx src/renderer/src/lib/useChromeCommands.ts`). If nothing navigates there, add a rail entry to the `RAIL` list in App.tsx following the existing entries' shape: `{ key: 'prs', icon: 'git-pull-request', label: 'Pull Requests', view: 'prs' }`.

- [ ] **Step 5: Full check + commit**

Run: `npm run typecheck && npx vitest run src/renderer/src/`
Expected: PASS.

```bash
git add src/renderer/src/lib/hiveView.ts src/renderer/src/lib/hiveView.test.ts src/renderer/src/components/PRsView.tsx src/renderer/src/App.tsx
git commit -m "feat(hive): PRs view derives live cards from story prUrl"
```

---

## Task 10: Seed cleanup + final verification

**Files:**
- Modify: `src/renderer/src/data/seed.ts`
- Delete: `src/renderer/src/components/MockDataRibbon.tsx`
- Modify: `src/renderer/src/App.tsx` (remove dead imports/comments)

- [ ] **Step 1: Confirm the dead surface**

```bash
grep -rn "from '.*data/seed'" src/renderer/src | grep -v seed.ts
grep -rn "MockDataRibbon" src/renderer/src
```

Expected consumers after Tasks 8–9: type-only imports (`Board`, `Story`, `Agent`, `LogLine`, `ChatMsg`, `RoleKey`, `LogClass`) plus `ROLE` (AgentDock, PRsView, primitives). The *value* arrays `board`, `roster`, `log`, `chat`, `problems`, `prs` must have zero remaining importers (App's `problems` import is dead — audit-confirmed never rendered). If any unexpected consumer appears, fix it first (wire it to live data or a type import), don't delete blindly.

- [ ] **Step 2: Prune `seed.ts`**

Delete the seed *data* and now-unused types:
- arrays `board`, `roster`, `log`, `chat`, `problems`, `prs`
- types `Problem`, `Severity`, `PullRequest`, `PrStatus`, `ChecksStatus` (PRsView now uses `PrCard`) — re-run the grep from Step 1 first; keep any type that still has importers
- the `L` helper + its trailing `void L`

Keep: `ROLE`, `Role`, `RoleKey`, `Story`, `StoryStatus`, `Board`, `Agent`, `AgentStatus`, `LogLine`, `LogClass`, `ChatMsg`.
Rewrite the file-header comment: this module now holds the panel prop *shapes* + role palette; live data comes from the hive adapters (`lib/hiveView.ts`).

- [ ] **Step 3: Delete dead component + imports**

```bash
git rm src/renderer/src/components/MockDataRibbon.tsx
```

In `App.tsx`: remove the `problems` import (line ~101) and update the stale header comments (lines ~37-39, ~528) that describe Dock/BottomPanel/PRsView as seed/mocked.

- [ ] **Step 4: Full suite + lint**

Run: `npm run typecheck && npx vitest run && npm run lint --if-present`
Expected: typecheck clean; ALL tests pass (736 baseline + ~25 new); lint clean (or only pre-existing warnings).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(seed): remove dead seed arrays + MockDataRibbon — hive panels are live"
```

---

## Task 11: Manual smoke + PR

- [ ] **Step 1: Manual smoke (npm run dev)**

1. Open a repo with uncommitted changes → SCM view → click a changed file → diff tab shows the hunk strip → "Stage hunk" moves that hunk to staged (SCM refreshes); open the staged (Index) diff → "Unstage hunk" reverses it.
2. Search for a common token → toggle Replace → uncheck one match + one whole file → Replace All → verify skipped lines/files unchanged on disk.
3. In a project with a hive workspace: Dock → Chat → send a message → `.hive/chat.ndjson` gains a line and the bubble appears; append a manager line by hand (`echo '{"ts":"2026-06-09T12:00:00Z","who":"manager","txt":"ack"}' >> .hive/chat.ndjson`) → bubble appears live.
4. Give a story a `prUrl` in `.hive/state/stories/<id>.md` frontmatter → PRs view lists it; Open launches the browser.
5. ⌘T and ⇧F12 still work in a TS file (TS worker path unchanged).

- [ ] **Step 2: Push + PR**

```bash
gh auth switch --user nikrich   # nikrich/hive-ide pushes 403 on the other account
git push -u origin HEAD:feat/parity-p1s-hive-live-data
gh pr create --repo nikrich/hive-ide --base main --head feat/parity-p1s-hive-live-data \
  --title "feat: parity P1s (hunk staging, replace opt-out, LSP symbols/references) + live hive panels"
```

PR body: summarize the four features + the audit doc reference + test counts.

---

## Self-Review (completed during authoring)

- **Coverage:** audit P1 #1 (hunk staging UI) → Task 3; P1 #2 (replace opt-out) → Tasks 1–2; P1 #4 (LSP ⌘T/⇧F12) → Tasks 4–6; hive seed replacement (chat file-backed, PRs from `prUrl`, dead-seed deletion) → Tasks 7–10; verification + PR → Task 11.
- **Type consistency:** `excludeLines?: Record<string, number[]>` used identically in Tasks 1–2; `DiffHunkBar({hunks, mode, busyIndex, onApply})` defined Task 3 Step 3 = consumed Step 5; `getActiveLspClients`/`findClientForLanguage`/`fileUriToPath` defined Task 4–5, consumed Task 5–6; `HiveChatMessage`/`parseChatLine`/`appendChatMessage`/`toChatMsgs`/`sendChat`/`onChat` consistent across Tasks 7–8; `PrCard`/`toPrCards` consistent across Task 9.
- **Placeholders:** none — every code step has the actual code; the two "check the existing shape first" notes (preload replace passthrough, `Btn` props) are verification instructions against named files, not TBDs.
