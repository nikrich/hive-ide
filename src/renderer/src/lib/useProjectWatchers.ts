/**
 * Project file-watcher lifecycle.
 *
 * The external-change pipeline (chokidar in main → `onFsChange` →
 * `classifyFsChange` → Editor/SCM) already exists; it just needs a watcher
 * started for every repo in the open project. This module owns that: a pure
 * `reconcileWatchers` that diffs desired vs. running watchers, plus a thin
 * `useProjectWatchers` hook (added in a later task) that feeds it the store's
 * repos.
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
