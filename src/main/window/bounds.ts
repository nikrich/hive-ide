/**
 * Window bounds ⇄ PersistedState — REQ-002 / STORY-020.
 *
 * Pure helpers used by main bootstrap to:
 *
 *   1. Translate `PersistedState.window` into the four fields
 *      `new BrowserWindow({...})` actually consumes on first open.
 *   2. Listen for `resize` / `move` on the live window and push the new
 *      bounds back into the persisted-state store. The store's own
 *      250 ms debounce coalesces the noisy event stream from a drag op
 *      so we don't write to disk on every pixel of motion.
 *
 * Kept in their own module so they can be unit-tested without spinning
 * up Electron, the way the project handlers and state migrator already are.
 */

import type { PersistedState } from '../../types/workspace';

/** Subset of `BrowserWindow.getBounds()` we read. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The slice of `BrowserWindow` the persistence wiring touches. Defined
 * locally (rather than importing `BrowserWindow` from `electron`) so
 * tests can pass a hand-rolled fake without dragging the native runtime
 * into the Node-only vitest environment.
 */
export interface BoundsWindow {
  isDestroyed(): boolean;
  getBounds(): Bounds;
  on(event: 'resize' | 'move', listener: () => void): void;
  removeListener(event: 'resize' | 'move', listener: () => void): void;
}

/** The window block we feed into the `BrowserWindow` constructor. */
export interface InitialBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/**
 * Project the persisted-state window block into the four fields
 * `BrowserWindow` accepts. `x` / `y` may be `undefined` on a fresh
 * install — we pass through so the platform centers the window.
 */
export function boundsFromState(state: PersistedState): InitialBounds {
  const { width, height, x, y } = state.window;
  return { width, height, x, y };
}

/**
 * Merge fresh window bounds back into a persisted-state snapshot.
 * Returns a new object — never mutates either input.
 */
export function persistBounds(state: PersistedState, bounds: Bounds): PersistedState {
  return {
    ...state,
    window: {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
    },
  };
}

/**
 * Attach `resize` and `move` listeners to `win` that push the new bounds
 * back into the store on every event.
 *
 * The state is re-read on every event so a concurrent renderer-side save
 * (e.g. a tab change) won't get clobbered by stale data sitting in a
 * closure. The store's `save()` debounces internally, so it is safe to
 * call on every emit.
 *
 * Returns a cleanup function that removes both listeners.
 */
export function attachBoundsPersistence(
  win: BoundsWindow,
  getState: () => PersistedState,
  save: (state: PersistedState) => void,
): () => void {
  const persist = (): void => {
    if (win.isDestroyed()) return;
    const next = persistBounds(getState(), win.getBounds());
    save(next);
  };
  win.on('resize', persist);
  win.on('move', persist);
  return () => {
    win.removeListener('resize', persist);
    win.removeListener('move', persist);
  };
}
