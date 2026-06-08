/**
 * Main-process settings store (E4-01).
 *
 * Owns the on-disk `settings.json` file — the user override layer. The file
 * is a flat partial settings object (VSCode-style), so "Edit in settings.json"
 * opens a file the user can read and hand-edit directly.
 *
 * Responsibilities:
 *   1. **Persist** the user override layer to `settings.json` via
 *      `electron-store`.
 *   2. **Merge** that layer over {@link DEFAULT_SETTINGS} on read, so callers
 *      always get a total {@link Settings} object.
 *   3. **Broadcast** changes — whether they arrive through the IPC `update` /
 *      `replace` calls OR through an external hand-edit of the file — so the
 *      renderer can re-theme / re-configure live without a restart.
 *   4. **IPC** — {@link registerSettingsIpc} wires `settings:get` /
 *      `settings:update` / `settings:replace` to `ipcMain.handle`, and pushes
 *      `event:settings:changed` to the focused window on every change.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import ElectronStore from 'electron-store';

import {
  applyPatch,
  mergeSettings,
  sanitizeUser,
  type PartialSettings,
  type Settings,
} from '../../types/settings';

/** IPC channel names — exported so the preload bridge can reuse them. */
export const SETTINGS_GET_CHANNEL = 'settings:get';
export const SETTINGS_UPDATE_CHANNEL = 'settings:update';
export const SETTINGS_REPLACE_CHANNEL = 'settings:replace';
/** Push channel: main → renderer whenever settings change. */
export const SETTINGS_CHANGED_EVENT = 'event:settings:changed';

/** The shape returned by `settings:get` — merged + raw user layer + path. */
export interface SettingsBundle {
  /** {@link DEFAULT_SETTINGS} with the user layer merged on top. */
  settings: Settings;
  /** The raw user override layer (the contents of `settings.json`). */
  user: PartialSettings;
  /** Absolute path of `settings.json` — used by the JSON escape hatch. */
  path: string;
}

export interface SettingsStoreOptions {
  /** Override the file name (default `'settings'`). Test hook. */
  name?: string;
  /** Override the directory (default app userData). Test hook. */
  cwd?: string;
}

/**
 * Owns `settings.json`. Construct once at app start; share the instance.
 */
export class SettingsStore {
  readonly #store: ElectronStore<PartialSettings>;
  readonly #listeners = new Set<(settings: Settings) => void>();

  constructor(options?: SettingsStoreOptions) {
    this.#store = new ElectronStore<PartialSettings>({
      name: options?.name ?? 'settings',
      cwd: options?.cwd,
      // A fresh settings file is an empty object — every effective value
      // comes from DEFAULT_SETTINGS until the user overrides it.
      defaults: {},
      // electron-store would otherwise clear unknown keys against a schema;
      // we keep the file permissive so a forward-compat key survives a
      // downgrade. Validation happens in mergeSettings on read.
    });

    // External hand-edits to settings.json fire this; rebroadcast so the
    // renderer reconfigures live. IPC-driven writes also pass through here.
    this.#store.onDidAnyChange(() => {
      const merged = this.get();
      for (const listener of this.#listeners) listener(merged);
    });
  }

  /** Absolute path of the on-disk file. */
  get path(): string {
    return this.#store.path;
  }

  /** The merged, total settings object. */
  get(): Settings {
    return mergeSettings(this.getUser());
  }

  /** The raw user override layer (contents of `settings.json`). */
  getUser(): PartialSettings {
    return { ...this.#store.store };
  }

  /**
   * Merge `patch` into the user layer and persist. Keys whose value equals
   * the default are dropped so `settings.json` stays minimal (only real
   * overrides are recorded). Returns the new merged settings.
   */
  update(patch: PartialSettings): Settings {
    this.#store.store = applyPatch(this.getUser(), patch);
    return this.get();
  }

  /**
   * Replace the entire user override layer. Used when the user edits
   * `settings.json` through the in-app JSON editor and saves it back.
   * Only keys known to {@link DEFAULT_SETTINGS} are kept.
   */
  replaceUser(user: PartialSettings): Settings {
    this.#store.store = sanitizeUser(user);
    return this.get();
  }

  /** Subscribe to merged-settings changes. Returns an unsubscribe fn. */
  onChange(listener: (settings: Settings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/**
 * Wire `settings:get` / `settings:update` / `settings:replace` to the store,
 * and push `event:settings:changed` to the supplied window on every change.
 *
 * Returns a teardown that removes the handlers + the change subscription.
 */
export function registerSettingsIpc(
  store: SettingsStore,
  getMainWindow: () => BrowserWindow | null,
): () => void {
  ipcMain.handle(SETTINGS_GET_CHANNEL, (): SettingsBundle => ({
    settings: store.get(),
    user: store.getUser(),
    path: store.path,
  }));
  ipcMain.handle(
    SETTINGS_UPDATE_CHANNEL,
    (_event, patch: PartialSettings): Settings => store.update(patch),
  );
  ipcMain.handle(
    SETTINGS_REPLACE_CHANNEL,
    (_event, user: PartialSettings): Settings => store.replaceUser(user),
  );

  const unsubscribe = store.onChange((settings) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(SETTINGS_CHANGED_EVENT, settings);
    }
  });

  return () => {
    ipcMain.removeHandler(SETTINGS_GET_CHANNEL);
    ipcMain.removeHandler(SETTINGS_UPDATE_CHANNEL);
    ipcMain.removeHandler(SETTINGS_REPLACE_CHANNEL);
    unsubscribe();
  };
}
