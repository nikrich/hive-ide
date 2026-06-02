/**
 * window/bounds.ts — REQ-002 / STORY-020.
 *
 * Three things to verify:
 *   - `boundsFromState` projects the persisted window block to BrowserWindow
 *     constructor options without mangling `undefined` x / y.
 *   - `persistBounds` returns a new object with the new bounds and leaves
 *     the rest of the state untouched.
 *   - `attachBoundsPersistence` wires `resize` / `move` to a debounced save
 *     (delegated to the store), no-ops when the window is destroyed, and
 *     cleans up listeners on teardown.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  attachBoundsPersistence,
  boundsFromState,
  persistBounds,
  type Bounds,
  type BoundsWindow,
} from './bounds';
import type { PersistedState } from '../../types/workspace';

function makeState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    schemaVersion: 1,
    lastProjectId: null,
    recents: [],
    projects: {},
    window: { width: 1480, height: 920 },
    ...overrides,
  };
}

class FakeWindow implements BoundsWindow {
  destroyed = false;
  bounds: Bounds = { x: 100, y: 200, width: 800, height: 600 };
  listeners = new Map<'resize' | 'move', Set<() => void>>();

  isDestroyed(): boolean {
    return this.destroyed;
  }
  getBounds(): Bounds {
    return this.bounds;
  }
  on(event: 'resize' | 'move', listener: () => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }
  removeListener(event: 'resize' | 'move', listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: 'resize' | 'move'): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

describe('boundsFromState()', () => {
  it('passes through width/height/x/y when all present', () => {
    const state = makeState({
      window: { width: 1024, height: 768, x: 50, y: 60 },
    });
    expect(boundsFromState(state)).toEqual({
      width: 1024,
      height: 768,
      x: 50,
      y: 60,
    });
  });

  it('returns undefined x/y on a fresh install', () => {
    const state = makeState({ window: { width: 1024, height: 768 } });
    const out = boundsFromState(state);
    expect(out.width).toBe(1024);
    expect(out.height).toBe(768);
    expect(out.x).toBeUndefined();
    expect(out.y).toBeUndefined();
  });
});

describe('persistBounds()', () => {
  it('replaces the window block, preserves the rest of the state', () => {
    const state = makeState({
      lastProjectId: 'abc',
      recents: [
        {
          id: 'abc',
          name: 'demo',
          rootPath: '/tmp/demo',
          source: 'single-repo',
          repoCount: 1,
          lastOpenedAt: 123,
        },
      ],
    });
    const next = persistBounds(state, { x: 10, y: 20, width: 900, height: 700 });

    expect(next).not.toBe(state);
    expect(next.window).toEqual({ width: 900, height: 700, x: 10, y: 20 });
    expect(next.lastProjectId).toBe('abc');
    expect(next.recents).toBe(state.recents);
  });
});

describe('attachBoundsPersistence()', () => {
  it('persists bounds on resize', () => {
    const win = new FakeWindow();
    let state = makeState();
    const save = vi.fn((next: PersistedState) => {
      state = next;
    });

    attachBoundsPersistence(win, () => state, save);
    win.bounds = { x: 11, y: 22, width: 1000, height: 800 };
    win.emit('resize');

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].window).toEqual({
      width: 1000,
      height: 800,
      x: 11,
      y: 22,
    });
  });

  it('persists bounds on move', () => {
    const win = new FakeWindow();
    const save = vi.fn();
    attachBoundsPersistence(win, () => makeState(), save);
    win.emit('move');

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reads fresh state on every emit so renderer saves are not clobbered', () => {
    const win = new FakeWindow();
    let state = makeState({ lastProjectId: 'first' });
    const save = vi.fn((next: PersistedState) => {
      state = next;
    });
    attachBoundsPersistence(win, () => state, save);

    win.emit('resize');
    // Simulate a renderer-side save changing lastProjectId between resize events.
    state = { ...state, lastProjectId: 'second' };
    win.emit('resize');

    expect(save.mock.calls[1][0].lastProjectId).toBe('second');
  });

  it('is a no-op when the window has been destroyed', () => {
    const win = new FakeWindow();
    win.destroyed = true;
    const save = vi.fn();
    attachBoundsPersistence(win, () => makeState(), save);

    win.emit('resize');
    win.emit('move');

    expect(save).not.toHaveBeenCalled();
  });

  it('teardown removes both listeners', () => {
    const win = new FakeWindow();
    const save = vi.fn();
    const teardown = attachBoundsPersistence(win, () => makeState(), save);

    teardown();
    win.emit('resize');
    win.emit('move');

    expect(save).not.toHaveBeenCalled();
    expect(win.listeners.get('resize')?.size ?? 0).toBe(0);
    expect(win.listeners.get('move')?.size ?? 0).toBe(0);
  });
});
