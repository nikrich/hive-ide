/**
 * External-change state machine — STORY-026.
 *
 * The Editor subscribes to `window.hive.onFsChange` and feeds every event
 * through {@link classifyFsChange}. That function is pure: given the event
 * + a snapshot of the relevant tab state, it returns the *intent* the
 * Editor should act on (silent reload, show banner, close + toast, etc).
 *
 * Keeping the decision logic out of React (no hooks, no `window.hive`)
 * makes it trivially testable with Vitest — see `externalChange.test.ts`.
 *
 * The Editor remains responsible for the side effects: calling
 * `window.hive.fs.readFile`, updating the store, rendering the banner,
 * showing the toast, invalidating the explorer cache. This module just
 * tells it *what* to do.
 */
import type { FsChangeEvent, FsChangeKind } from '../../../preload/api'

/**
 * The set of intents the classifier can hand back to the Editor.
 *
 * - `silent-reload`   open + clean + 'change' → re-read disk, preserve viewState,
 *                     do NOT show a banner.
 * - `show-banner`     open + dirty + 'change' → render the external-change
 *                     banner over the editor area; user picks Reload / Keep / Compare.
 * - `close-with-toast` open + 'unlink' → close the affected tab, fire a toast
 *                     `'<path>' was deleted on disk`.
 * - `refresh-parent`  tree-level add/unlink/addDir/unlinkDir for a path NOT
 *                     matching any open tab → invalidate the parent's listDir
 *                     cache so the Explorer re-fetches.
 * - `ignore`          everything else (e.g. 'add' on a path that is somehow
 *                     also open — should never happen in practice; the
 *                     classifier degrades gracefully).
 */
export type ExternalChangeIntent =
  | { kind: 'silent-reload'; path: string }
  | { kind: 'show-banner'; path: string }
  | { kind: 'close-with-toast'; path: string }
  | { kind: 'refresh-parent'; path: string; parent: string }
  | { kind: 'ignore' }

/**
 * Inputs the classifier needs for one event. The Editor pulls these from
 * the Zustand store at event time — see the `useEffect` in `Editor.tsx`.
 */
export interface ExternalChangeContext {
  /** True if the event's path is the path of an open tab. */
  isOpenTab: boolean
  /** True if the open tab (if any) has unsaved in-memory edits. */
  isDirty: boolean
}

/**
 * The pure decision: takes an FsChangeEvent + context, returns intent.
 *
 * Decision table:
 *
 * | kind        | isOpenTab | isDirty | result            |
 * |-------------|-----------|---------|-------------------|
 * | change      | true      | false   | silent-reload     |
 * | change      | true      | true    | show-banner       |
 * | change      | false     | -       | refresh-parent    |
 * | unlink      | true      | -       | close-with-toast  |
 * | unlink      | false     | -       | refresh-parent    |
 * | add         | true      | -       | ignore (defensive)|
 * | add         | false     | -       | refresh-parent    |
 * | addDir      | -         | -       | refresh-parent    |
 * | unlinkDir   | -         | -       | refresh-parent    |
 */
export function classifyFsChange(
  event: FsChangeEvent,
  ctx: ExternalChangeContext,
): ExternalChangeIntent {
  const { path, kind } = event

  switch (kind) {
    case 'change':
      if (ctx.isOpenTab) {
        return ctx.isDirty
          ? { kind: 'show-banner', path }
          : { kind: 'silent-reload', path }
      }
      return { kind: 'refresh-parent', path, parent: parentOf(path) }

    case 'unlink':
      if (ctx.isOpenTab) {
        return { kind: 'close-with-toast', path }
      }
      return { kind: 'refresh-parent', path, parent: parentOf(path) }

    case 'add':
      // An 'add' for an already-open tab is logically impossible (you can't
      // open a non-existent file), but if it happens we don't want to do
      // anything destructive — let it pass through.
      if (ctx.isOpenTab) return { kind: 'ignore' }
      return { kind: 'refresh-parent', path, parent: parentOf(path) }

    case 'addDir':
    case 'unlinkDir':
      return { kind: 'refresh-parent', path, parent: parentOf(path) }

    default: {
      // Exhaustiveness check: if `FsChangeKind` ever grows, TS will fail here.
      const _exhaustive: never = kind
      void _exhaustive
      return { kind: 'ignore' }
    }
  }
}

/**
 * Strip the last segment off an absolute path. Detects separator from the
 * input so Windows + POSIX both work without dragging `path` from Node.
 *
 * Exported for the test suite.
 */
export function parentOf(p: string): string {
  const sep: '\\' | '/' = p.includes('\\') ? '\\' : '/'
  const idx = p.lastIndexOf(sep)
  // Root or no separator → return the input untouched; the caller decides
  // what to do (a root path having no parent is fine — invalidating it is
  // a no-op, since the Explorer doesn't cache root listings under root).
  if (idx <= 0) return p
  return p.slice(0, idx)
}

/**
 * Re-export the event kind so consumers don't have to import preload directly.
 */
export type { FsChangeKind }
