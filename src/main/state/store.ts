/**
 * Main-process persisted state — REQ-002 / STORY-019.
 *
 * Wraps `electron-store` so the rest of the main process can read and write
 * `PersistedState` without knowing the on-disk layout. Three responsibilities,
 * none of which `electron-store` owns directly:
 *
 *   1. **Schema migration** — run `migrate()` once at construction so a
 *      future-version or malformed file gets archived to `workspace.v0.bak`
 *      and replaced with sane defaults, instead of crashing the renderer
 *      on first read.
 *   2. **Debounce** — `save()` calls are coalesced for 250 ms so a noisy
 *      stream of UI changes (e.g. dragging the splitter) doesn't hammer
 *      the disk. The pending write is flushed before quit (via
 *      {@link PersistedStateStore.flush}) so the last edit is never lost.
 *   3. **IPC** — {@link registerStateIpc} wires `state:get` / `state:save`
 *      to `ipcMain.handle` so the preload bridge can reach the store.
 *      STORY-020 (app bootstrap wire-up) is the one that actually calls
 *      it; isolating registration in a function keeps this module
 *      importable from tests without dragging the `app` lifecycle in.
 */

import { ipcMain } from 'electron';
import ElectronStore from 'electron-store';

import { defaults, migrate } from './migrate';
import type { PersistedState } from '../../types/workspace';

/** How long save() waits for further calls before writing to disk. */
export const SAVE_DEBOUNCE_MS = 250;

/** IPC channel names — exported so the preload bridge can reuse them. */
export const STATE_GET_CHANNEL = 'state:get';
export const STATE_SAVE_CHANNEL = 'state:save';

/** Options accepted by {@link PersistedStateStore}. Both fields are test hooks. */
export interface PersistedStateStoreOptions {
  /** Override the `electron-store` file name (default: `'workspace'`). */
  name?: string;
  /** Override the `electron-store` directory (default: app userData). */
  cwd?: string;
}

/**
 * Owns the on-disk `workspace.json` file.
 *
 * Construct once at app start, share the instance with anything that needs
 * to read or write state, and call `flush()` from `app.on('before-quit')`
 * so a pending debounced write doesn't lose the user's last edit.
 */
export class PersistedStateStore {
  /** The wrapped `electron-store` instance. */
  readonly #store: ElectronStore<PersistedState>;

  /** Currently-pending state (set by `save`, cleared by `flush`). */
  #pending: PersistedState | null = null;

  /** Active debounce timer, or `null` when nothing is queued. */
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: PersistedStateStoreOptions) {
    // We construct the store with `defaults` so the underlying file always
    // ends up with a sane shape even if migration is a no-op. `migrate()`
    // still runs against whatever was on disk before defaults were merged.
    this.#store = new ElectronStore<PersistedState>({
      name: options?.name ?? 'workspace',
      cwd: options?.cwd,
      defaults: defaults(),
    });

    const raw: unknown = this.#store.store;
    const migrated = migrate(raw, this.#store.path);

    // `migrate()` returns the same reference for valid v1 payloads, so this
    // identity check avoids a useless write on every launch.
    if (migrated !== raw) {
      this.#store.store = migrated;
    }
  }

  /** Absolute path of the on-disk file. Exposed mainly for diagnostics. */
  get path(): string {
    return this.#store.path;
  }

  /** Read the current state synchronously. */
  get(): PersistedState {
    return this.#store.store;
  }

  /**
   * Queue a write. Coalesced with any other `save()` call inside the same
   * 250 ms window — only the most recent state is written.
   */
  save(state: PersistedState): void {
    this.#pending = state;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Force-write any pending state immediately. Safe to call when nothing
   * is queued; it just clears the timer. Call from `app.on('before-quit')`.
   */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#pending !== null) {
      this.#store.store = this.#pending;
      this.#pending = null;
    }
  }

  /**
   * Cancel any queued write without persisting. Used by tests; in production
   * you almost certainly want `flush()` instead.
   */
  cancel(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pending = null;
  }
}

/**
 * Wire `state:get` and `state:save` to the supplied store via `ipcMain.handle`.
 *
 * Idempotent within reason — calling it twice on the same channel will
 * throw, matching Electron's behaviour. STORY-020 calls this exactly once
 * during app bootstrap.
 */
export function registerStateIpc(store: PersistedStateStore): void {
  ipcMain.handle(STATE_GET_CHANNEL, () => store.get());
  ipcMain.handle(STATE_SAVE_CHANNEL, (_event, state: PersistedState) => {
    store.save(state);
  });
}

/**
 * Tear down the IPC handlers registered by {@link registerStateIpc}.
 *
 * Useful in tests and for in-development hot-reload of the main process.
 */
export function unregisterStateIpc(): void {
  ipcMain.removeHandler(STATE_GET_CHANNEL);
  ipcMain.removeHandler(STATE_SAVE_CHANNEL);
}
