# Auto-sync External File Changes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the existing chokidar file watcher for every repo in the open project so external file changes auto-sync into the IDE, and filter watch noise so it's safe on real repos.

**Architecture:** The whole external-change pipeline (watcher → debounced IPC → `onFsChange` → `classifyFsChange` → Editor/SCM) already exists; nothing starts a watcher. We add (1) a main-process ignore predicate so chokidar skips `.git`/`node_modules`/build dirs, and (2) a store-driven renderer hook `useProjectWatchers` that reconciles one watcher per `repo.path`. The reconciliation logic is extracted into a pure async function so it's unit-testable without React (mirroring how `classifyFsChange` is pure and the effect just calls it).

**Tech Stack:** TypeScript, Electron (main + preload + renderer), React 18, Zustand, chokidar v4, Vitest (node env — no jsdom/RTL; tests drive pure functions and stub `globalThis.window`).

---

## File Structure

- **Create** `src/renderer/src/lib/useProjectWatchers.ts` — exports the pure `reconcileWatchers()` + `WatcherBridge` interface, and the thin `useProjectWatchers()` React hook.
- **Create** `src/renderer/src/lib/useProjectWatchers.test.ts` — Vitest unit tests for `reconcileWatchers()`.
- **Modify** `src/main/project/handlers.ts` — add exported `isIgnoredWatchPath()` predicate; pass a root-relative wrapper of it as chokidar's `ignored` option in `defaultDeps().createWatcher`.
- **Modify** `src/main/project/handlers.test.ts` — tests for `isIgnoredWatchPath()`.
- **Modify** `src/renderer/src/App.tsx` — call `useProjectWatchers()` once in the app shell.

---

## Task 1: Main-process ignore predicate

**Files:**
- Modify: `src/main/project/handlers.ts` (imports near line 45; `defaultDeps().createWatcher` at lines 140-149)
- Test: `src/main/project/handlers.test.ts`

The predicate operates on a path **relative to the watch root**, so a repo whose own folder happens to be named `build` still gets watched — only `build` *inside* the repo is ignored.

- [ ] **Step 1: Write the failing test**

Add to `src/main/project/handlers.test.ts` (import `isIgnoredWatchPath` from `./handlers` in the existing import block at the top of the file):

```ts
describe('isIgnoredWatchPath', () => {
  it('ignores common noise directories anywhere in the relative path', () => {
    expect(isIgnoredWatchPath('node_modules/react/index.js')).toBe(true)
    expect(isIgnoredWatchPath('.git/HEAD')).toBe(true)
    expect(isIgnoredWatchPath('packages/app/dist/bundle.js')).toBe(true)
    expect(isIgnoredWatchPath('build/output.o')).toBe(true)
    expect(isIgnoredWatchPath('out/main/index.js')).toBe(true)
    expect(isIgnoredWatchPath('.next/cache/x')).toBe(true)
    expect(isIgnoredWatchPath('coverage/lcov.info')).toBe(true)
    expect(isIgnoredWatchPath('src/.DS_Store')).toBe(true)
  })

  it('does not ignore ordinary source files', () => {
    expect(isIgnoredWatchPath('src/index.ts')).toBe(false)
    expect(isIgnoredWatchPath('README.md')).toBe(false)
    expect(isIgnoredWatchPath('')).toBe(false) // the watch root itself
  })

  it('handles Windows separators', () => {
    expect(isIgnoredWatchPath('packages\\app\\node_modules\\x')).toBe(true)
    expect(isIgnoredWatchPath('src\\app\\main.ts')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/project/handlers.test.ts -t isIgnoredWatchPath`
Expected: FAIL — `isIgnoredWatchPath is not a function` / import error.

- [ ] **Step 3: Add the predicate and wire it into the watcher**

In `src/main/project/handlers.ts`, add `relative` to the existing `node:path` usage. There is currently no `node:path` import — add one near the other imports (after line 45):

```ts
import { relative } from 'node:path';
```

Add the predicate near the top of the file, after the channel/tuning constants block (the `export const ... as const` group ending around line 61):

```ts
/**
 * Path segments we never want to watch — watching them floods IPC and
 * triggers spurious reloads. The predicate runs on a path **relative to the
 * watch root**, so a repo whose own folder is named e.g. `build` is still
 * watched; only a `build` directory *inside* the repo is skipped. Centralised
 * here so the ignore set is tunable in one place.
 */
const IGNORED_WATCH_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.DS_Store',
]);

/** True if a root-relative path contains an ignored segment. */
export function isIgnoredWatchPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => IGNORED_WATCH_SEGMENTS.has(segment));
}
```

Then change the `createWatcher` factory in `defaultDeps()` (lines 140-149) to pass the `ignored` predicate. Replace:

```ts
    createWatcher: (rootPath) =>
      adaptChokidarWatcher(
        chokidarWatch(rootPath, {
          ignoreInitial: true,
          persistent: true,
          // chokidar's own awaitWriteFinish is *not* used — we do our own
          // 100ms debounce at the IPC boundary so we keep control over the
          // renderer-facing batching semantics.
        }),
      ),
```

with:

```ts
    createWatcher: (rootPath) =>
      adaptChokidarWatcher(
        chokidarWatch(rootPath, {
          ignoreInitial: true,
          persistent: true,
          // chokidar v4's `ignored` must be a predicate (glob strings were
          // dropped in v4). We test it against the path *relative to the
          // root* so the root folder itself is never accidentally ignored.
          ignored: (watchedPath: string) =>
            isIgnoredWatchPath(relative(rootPath, watchedPath)),
          // chokidar's own awaitWriteFinish is *not* used — we do our own
          // 100ms debounce at the IPC boundary so we keep control over the
          // renderer-facing batching semantics.
        }),
      ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/project/handlers.test.ts -t isIgnoredWatchPath`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full handlers suite to confirm no regression**

Run: `npx vitest run src/main/project/handlers.test.ts`
Expected: PASS (existing watcher tests + the 3 new ones).

- [ ] **Step 6: Commit**

```bash
git add src/main/project/handlers.ts src/main/project/handlers.test.ts
git commit -m "feat(watch): ignore .git/node_modules/build noise in project watcher"
```

---

## Task 2: Pure watcher-reconciliation function

**Files:**
- Create: `src/renderer/src/lib/useProjectWatchers.ts`
- Test: `src/renderer/src/lib/useProjectWatchers.test.ts`

This task creates ONLY the pure function + interface. The React hook is added in Task 3 (same file).

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/useProjectWatchers.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { reconcileWatchers, type WatcherBridge } from './useProjectWatchers'

/**
 * A fake bridge that hands out sequential ids and records calls. `watch`
 * resolves immediately unless an override is supplied per-path.
 */
function makeBridge(overrides: {
  watch?: (path: string) => Promise<string>
} = {}): WatcherBridge & {
  watched: string[]
  unwatched: string[]
} {
  let n = 0
  const watched: string[] = []
  const unwatched: string[] = []
  return {
    watched,
    unwatched,
    watch:
      overrides.watch ??
      (async (path: string) => {
        watched.push(path)
        n += 1
        return `id-${n}`
      }),
    unwatch: async (id: string) => {
      unwatched.push(id)
    },
  }
}

const always = () => true

describe('reconcileWatchers', () => {
  it('starts one watcher per desired path on a cold map', async () => {
    const active = new Map<string, string>()
    const pending = new Set<string>()
    const bridge = makeBridge()

    await reconcileWatchers(['/a', '/b'], active, pending, bridge, always)

    expect(bridge.watched).toEqual(['/a', '/b'])
    expect([...active.entries()]).toEqual([
      ['/a', 'id-1'],
      ['/b', 'id-2'],
    ])
    expect(bridge.unwatched).toEqual([])
  })

  it('does not restart an already-watched path', async () => {
    const active = new Map<string, string>([['/a', 'id-1']])
    const pending = new Set<string>()
    const bridge = makeBridge()

    await reconcileWatchers(['/a', '/b'], active, pending, bridge, always)

    expect(bridge.watched).toEqual(['/b']) // only the new one
    expect(active.get('/a')).toBe('id-1')
  })

  it('unwatches paths that are no longer desired', async () => {
    const active = new Map<string, string>([
      ['/a', 'id-1'],
      ['/b', 'id-2'],
    ])
    const pending = new Set<string>()
    const bridge = makeBridge()

    await reconcileWatchers(['/a'], active, pending, bridge, always)

    expect(bridge.unwatched).toEqual(['id-2'])
    expect([...active.keys()]).toEqual(['/a'])
  })

  it('cleans up an orphan when the path is removed mid-watch', async () => {
    const active = new Map<string, string>()
    const pending = new Set<string>()
    const bridge = makeBridge()
    // Simulate "/a was removed while watch() was in flight": the
    // still-desired check returns false for it.
    const isStillDesired = (p: string) => p !== '/a'

    await reconcileWatchers(['/a'], active, pending, bridge, isStillDesired)

    expect(bridge.watched).toEqual(['/a'])
    expect(bridge.unwatched).toEqual(['id-1']) // orphan immediately dropped
    expect(active.has('/a')).toBe(false)
    expect(pending.has('/a')).toBe(false)
  })

  it('swallows a watch failure and still processes siblings', async () => {
    const active = new Map<string, string>()
    const pending = new Set<string>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge = makeBridge({
      watch: async (path: string) => {
        if (path === '/bad') throw new Error('boom')
        return `id-${path}`
      },
    })

    await reconcileWatchers(['/bad', '/good'], active, pending, bridge, always)

    expect(active.has('/bad')).toBe(false)
    expect(pending.has('/bad')).toBe(false)
    expect(active.get('/good')).toBe('id-/good')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/lib/useProjectWatchers.test.ts`
Expected: FAIL — cannot resolve `./useProjectWatchers` / `reconcileWatchers` not exported.

- [ ] **Step 3: Write the pure function**

Create `src/renderer/src/lib/useProjectWatchers.ts` with the interface + function (the hook is appended in Task 3):

```ts
/**
 * Project file-watcher lifecycle.
 *
 * The external-change pipeline (chokidar in main → `onFsChange` →
 * `classifyFsChange` → Editor/SCM) already exists; it just needs a watcher
 * started for every repo in the open project. This module owns that: a pure
 * `reconcileWatchers` that diffs desired vs. running watchers, plus a thin
 * `useProjectWatchers` hook (added below) that feeds it the store's repos.
 *
 * The reconcile logic is kept pure (no React, no `window.hive`) so it is
 * unit-testable in the project's node-env Vitest setup — same split as
 * `classifyFsChange`.
 */

/** The slice of `window.hive.project` this module needs. */
export interface WatcherBridge {
  watch(path: string): Promise<string>
  unwatch(watcherId: string): Promise<void>
}

/**
 * Reconcile the set of running watchers against `desired`.
 *
 * - `active`: path → watcherId for confirmed-running watchers. Mutated in place.
 * - `pending`: paths whose `watch()` is currently in flight. Mutated in place;
 *   prevents a concurrent reconcile from double-starting the same path.
 * - `isStillDesired`: re-checked AFTER an async `watch()` resolves, so a path
 *   removed mid-flight gets its orphan watcher cleaned up instead of leaked.
 *
 * Failures are logged and swallowed: one repo failing to watch must not crash
 * the app or block its siblings.
 */
export async function reconcileWatchers(
  desired: readonly string[],
  active: Map<string, string>,
  pending: Set<string>,
  bridge: WatcherBridge,
  isStillDesired: (path: string) => boolean,
): Promise<void> {
  const desiredSet = new Set(desired)

  // 1. Stop confirmed watchers whose path is no longer desired.
  for (const [path, id] of [...active]) {
    if (desiredSet.has(path)) continue
    active.delete(path)
    try {
      await bridge.unwatch(id)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('useProjectWatchers: unwatch failed', path, e)
    }
  }

  // 2. Start watchers for desired paths not already watched or starting.
  for (const path of desired) {
    if (active.has(path) || pending.has(path)) continue
    pending.add(path)
    let id: string
    try {
      id = await bridge.watch(path)
    } catch (e) {
      pending.delete(path)
      // eslint-disable-next-line no-console
      console.warn('useProjectWatchers: watch failed', path, e)
      continue
    }
    pending.delete(path)
    if (isStillDesired(path)) {
      active.set(path, id)
    } else {
      // Removed while watch() was in flight — drop the orphan watcher.
      try {
        await bridge.unwatch(id)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('useProjectWatchers: orphan unwatch failed', path, e)
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/lib/useProjectWatchers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/useProjectWatchers.ts src/renderer/src/lib/useProjectWatchers.test.ts
git commit -m "feat(watch): pure reconcileWatchers for project watcher lifecycle"
```

---

## Task 3: The `useProjectWatchers` hook

**Files:**
- Modify: `src/renderer/src/lib/useProjectWatchers.ts` (append the hook)

The hook is a thin React wrapper around `reconcileWatchers`; it is verified manually in Task 5 (the project has no jsdom/RTL setup to render hooks in unit tests, matching how the Editor's `onFsChange` effect is also not unit-tested).

- [ ] **Step 1: Append imports and the hook to `useProjectWatchers.ts`**

At the TOP of the file, add the React + store imports (above the file's doc comment is fine, but keep them as the first `import` lines):

```ts
import { useEffect, useRef } from 'react'

import { useWorkspaceStore } from '../store/workspaceStore'
```

At the BOTTOM of the file, append the hook:

```ts
/**
 * Start/stop a filesystem watcher for every repo in the active project.
 *
 * Store-driven: it reads `repos` from the workspace store and reconciles on
 * every change, so opening a project, adding a repo, removing a repo, and
 * closing the project (which empties `repos`) all flow through automatically.
 *
 * Native watcher ids are held in refs, never in the persisted store. On
 * unmount every watcher is torn down. Safe in tests/Storybook where
 * `window.hive` is absent — it becomes a no-op.
 */
export function useProjectWatchers(): void {
  const repos = useWorkspaceStore((s) => s.repos)

  const activeRef = useRef<Map<string, string>>(new Map())
  const pendingRef = useRef<Set<string>>(new Set())
  const desiredRef = useRef<readonly string[]>([])

  // Reconcile whenever the repo set changes.
  useEffect(() => {
    const bridge = window.hive?.project
    if (!bridge || typeof bridge.watch !== 'function') return

    const desired = repos.map((r) => r.path)
    desiredRef.current = desired

    void reconcileWatchers(
      desired,
      activeRef.current,
      pendingRef.current,
      bridge,
      (p) => desiredRef.current.includes(p),
    )
  }, [repos])

  // Tear every watcher down when the app shell unmounts.
  useEffect(() => {
    const active = activeRef.current
    return () => {
      desiredRef.current = []
      const bridge = window.hive?.project
      if (!bridge || typeof bridge.unwatch !== 'function') {
        active.clear()
        return
      }
      for (const [, id] of active) {
        void bridge.unwatch(id).catch((e) => {
          // eslint-disable-next-line no-console
          console.warn('useProjectWatchers: teardown unwatch failed', e)
        })
      }
      active.clear()
    }
  }, [])
}
```

- [ ] **Step 2: Typecheck the new code**

Run: `npm run typecheck`
Expected: PASS — no type errors. (`window.hive.project` is typed `HiveProjectBridge`, whose `watch`/`unwatch` satisfy `WatcherBridge`.)

- [ ] **Step 3: Re-run the unit tests (hook addition must not break the pure-function tests)**

Run: `npx vitest run src/renderer/src/lib/useProjectWatchers.test.ts`
Expected: PASS (still 5 tests).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/useProjectWatchers.ts
git commit -m "feat(watch): useProjectWatchers hook driving reconcile from store repos"
```

---

## Task 4: Wire the hook into the app shell

**Files:**
- Modify: `src/renderer/src/App.tsx` (import block ~line 50; component body after the store selectors ~line 196)

- [ ] **Step 1: Add the import**

In `src/renderer/src/App.tsx`, add alongside the other `./lib/*` / `./components/*` imports near the top:

```ts
import { useProjectWatchers } from './lib/useProjectWatchers'
```

- [ ] **Step 2: Call the hook in the App component**

In the `App()` body, immediately after the workspace-store selector block (right after `const fetchAllScm = useWorkspaceStore((s) => s.fetchAllScm)` at line 196), add:

```ts
  // Start filesystem watchers for the active project's repos so external
  // edits auto-sync into the IDE (REQ-002 external-change pipeline).
  useProjectWatchers()
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full test suite (no regressions anywhere)**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(watch): enable project file watchers in the app shell"
```

---

## Task 5: Manual end-to-end verification

**Files:** none (manual).

This proves the feature actually works in the running app — unit tests cover the pure pieces, but the watcher → IPC → reload round trip is only exercised live.

- [ ] **Step 1: Launch the app**

Run: `npm run dev`
Open (or create) a project pointing at a real folder with at least one git repo and some source files.

- [ ] **Step 2: Clean-buffer silent reload**

Open a file in the IDE (do not edit it). In an external terminal:

```bash
echo "// external edit $(date)" >> <that-file>
```

Expected: within ~100-200ms the editor content updates to include the new line, with NO banner.

- [ ] **Step 3: Dirty-buffer banner (no silent clobber)**

Edit an open file in the IDE so the tab is dirty (do not save). Externally append a different line to the same file. 
Expected: the external-change banner appears with Reload / Keep; the in-memory edits are NOT overwritten. Choosing Keep dismisses it and preserves your edits; choosing Reload loads the disk version.

- [ ] **Step 4: Deleted file closes the tab**

With a non-dirty file open, externally delete it (`rm <that-file>`). 
Expected: the tab closes and a toast reads `'<path>' was deleted on disk`.

- [ ] **Step 5: Explorer refresh for non-open paths**

With a folder expanded in the Explorer, externally create a new file inside it (`touch <folder>/new-file.ts`). 
Expected: the new file appears in the Explorer (cache invalidated + re-fetched).

- [ ] **Step 6: Noise is filtered**

Externally cause churn inside `node_modules` or `.git` (e.g. `touch node_modules/.probe` or run a git command that updates `.git`). 
Expected: NO editor reloads or Explorer churn from those paths (ignore predicate working).

- [ ] **Step 7: Confirm and note results**

Record that steps 2-6 behaved as expected. If any step fails, STOP and debug before considering the feature complete (use superpowers:systematic-debugging).

---

## Self-Review Notes

- **Spec coverage:** ignore predicate (Task 1) ↔ spec §Architecture.3; pure reconcile + race/orphan/failure handling (Task 2) ↔ spec §Architecture.1 + §Error handling; hook + store-driven lifecycle (Task 3) ↔ spec §Architecture.1; App mount (Task 4) ↔ spec §Architecture.2; clean-vs-dirty behavior + noise filtering + deletion/refresh (Task 5) ↔ spec §Behavior note + §Data flow. Out-of-scope items (retry, per-repo config) are intentionally absent.
- **Type consistency:** `WatcherBridge { watch(path): Promise<string>; unwatch(watcherId): Promise<void> }` is defined once in Task 2 and consumed unchanged in Task 3; it structurally matches `HiveProjectBridge` from `src/preload/api.ts`. `reconcileWatchers(desired, active, pending, bridge, isStillDesired)` has the same signature in its definition (Task 2) and its call site (Task 3). `isIgnoredWatchPath(relativePath)` defined and called consistently (Task 1).
- **No placeholders:** every code step contains complete, runnable content.
