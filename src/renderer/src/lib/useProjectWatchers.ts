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

import { useEffect, useRef } from 'react'

import { useWorkspaceStore } from '../store/workspaceStore'

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
