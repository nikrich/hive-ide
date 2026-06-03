# Auto-sync external file changes — design

**Date:** 2026-06-03
**Status:** Approved, pending implementation plan

## Problem

When a file in an open project changes on disk *outside* the IDE (a git
checkout, an agent writing files, an external editor), the IDE should pick the
change up automatically: silently reload clean buffers, refresh the Explorer
and Source Control views, and warn before clobbering unsaved edits.

The full pipeline to do this already exists and is unit-tested:

- **Main** (`src/main/project/handlers.ts`): a chokidar watcher with a 100ms
  debounce, exposed over IPC as `project:watch` / `project:unwatch`.
- **Preload** (`src/preload/api.ts`): `project.watch(path) → watcherId`,
  `project.unwatch(watcherId)`, and `onFsChange(handler)` for batched events.
- **Classifier** (`src/renderer/src/lib/externalChange.ts`): pure
  `classifyFsChange(event, ctx)` returning an intent
  (`silent-reload` / `show-banner` / `close-with-toast` / `refresh-parent` /
  `ignore`).
- **Consumers**: `Editor.tsx` and `SourceControlView.tsx` both subscribe to
  `onFsChange` and act on the classified intent.

**The only missing link:** nothing in the renderer ever calls
`window.hive.project.watch(...)`, so no watcher is started and zero events
flow. A project is a set of `repos` (each a top-level root), and repos can be
added/removed at runtime, so the fix is a watcher *lifecycle* keyed to the
active project's repos.

A second, related gap: the main-process chokidar watcher is created with **no
ignore list**, so once switched on it would watch `node_modules`, `.git`,
build output, etc. — an event storm on any real repo. That must be filtered as
part of this work.

## Constraints

- **chokidar v4** (`^4.0.3`). v4 dropped glob-string support: the `ignored`
  option must be a predicate function `(path: string) => boolean` (or
  regex/array), **not** glob strings.
- Watcher ids are non-serializable native handles tied to the main process —
  they must not live in the persisted Zustand store.
- Dirty (unsaved) buffers must never be silently overwritten.

## Architecture

Three changes.

### 1. New renderer hook — `src/renderer/src/lib/useProjectWatchers.ts`

A store-driven React hook that owns the watcher lifecycle.

- Selects `project?.repos` from the workspace store (a stable selector so it
  only re-runs when the repo set changes).
- Holds a `Map<repoPath, watcherId>` in a `useRef` — native handles stay out
  of the persisted store.
- An effect runs on every `repos` change and diffs the desired repo-path set
  against the currently-watched set:
  - **new path** → `await window.hive.project.watch(path)`, record its id.
  - **removed path** → `await window.hive.project.unwatch(id)`, drop the entry.
- On unmount (and on project close, which empties `repos`) → unwatch all.
- Guards:
  - Bails cleanly if `window.hive` (or `project.watch`) is absent — keeps the
    hook safe in tests / Storybook.
  - Wraps each `watch` / `unwatch` in try/catch, logging a single
    `console.warn` on failure (a watcher that fails to start must not crash the
    app or block the others).
  - Handles the async race where a `watch(path)` call resolves *after* that
    path was already removed from `repos`: if the path is no longer desired
    when the promise resolves, immediately `unwatch` the orphan id rather than
    recording it.

### 2. Mount point — `src/renderer/src/App.tsx`

Call `useProjectWatchers()` once at the top level of the app shell. Because the
hook is store-driven, opening a project, adding a repo, removing a repo, and
closing the project all flow through it automatically with no per-callsite
wiring.

### 3. Main-process ignore predicate — `src/main/project/handlers.ts`

- Add a named, exported, unit-testable predicate
  `isIgnoredWatchPath(path: string): boolean`.
- Pass it as chokidar v4's `ignored` function in
  `defaultDeps().createWatcher`.
- Default ignore set (matched by path segment): `.git`, `node_modules`,
  `dist`, `build`, `out`, `.next`, `coverage`, and `.DS_Store`. Centralized in
  this one predicate so the set is easy to tune later.

## Data flow (once enabled)

```
external write
  → chokidar (main, noise-filtered by isIgnoredWatchPath)
  → 100ms debounce + per-path collapse
  → event:* IPC
  → preload onFsChange
  → Editor / SourceControlView handler
  → classifyFsChange(event, { isOpenTab, isDirty })
      ├─ clean open buffer  → silent reload (re-read disk, preserve viewState)
      ├─ dirty open buffer  → external-change banner (Reload / Keep)
      ├─ deleted open file  → close tab + toast
      └─ non-open path      → refresh Explorer / SCM (invalidate listDir cache)
```

Watcher start path:

```
project opened / repo added
  → store.repos changes
  → useProjectWatchers effect
  → window.hive.project.watch(path) IPC
  → main registers a chokidar watcher rooted at path
```

## Behavior note

"Auto-sync" applies *silently* only to **clean** buffers. **Dirty** buffers
deliberately do not auto-overwrite — they raise the existing external-change
banner so the user explicitly chooses Reload or Keep. This prevents silent loss
of unsaved edits and is the already-designed, already-tested classifier
behavior; this work only enables it.

## Error handling

- `watch()` rejects → `console.warn`, leave the path unwatched. No retry (see
  Out of scope). Other repos are unaffected.
- `unwatch()` rejects → `console.warn`; drop the local entry regardless so the
  map doesn't leak.
- Async race (watch resolves after removal) → immediately unwatch the orphan
  id; never record it.
- `window.hive` absent → hook is a no-op.

## Testing

- `src/renderer/src/lib/useProjectWatchers.test.ts`: mock
  `window.hive.project.watch` / `unwatch`; drive store changes and assert:
  - a watch is started per repo on project open;
  - adding a repo starts exactly one new watch; removing a repo unwatches
    exactly that one;
  - unmount (and emptying repos) unwatches all;
  - the async-race orphan is immediately unwatched, not leaked;
  - a rejected `watch` is swallowed (warns, does not throw) and does not block
    sibling repos.
- `isIgnoredWatchPath` unit tests (in `src/main/project/handlers.test.ts` or a
  sibling): `node_modules` and `.git` paths are ignored; ordinary source files
  (e.g. `src/index.ts`) are not.

## Out of scope (YAGNI)

- Watch retry / backoff on failure.
- Per-repo or user-configurable ignore lists.
- Watching paths outside the active project's repos.
- Any change to the classifier or banner UX — those are already built.
