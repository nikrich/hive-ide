/**
 * Renderer settings store (E4-01).
 *
 * A small Zustand store holding the merged {@link Settings} plus the raw user
 * override layer and the on-disk `settings.json` path. Components read a single
 * setting reactively:
 *
 *   const minimap = useSettingsStore((s) => s.settings['editor.minimap'])
 *
 * Writes go through `set(key, value)` (a single key) or `replaceUser(...)` (the
 * whole layer, used by the JSON escape hatch). Both round-trip to main and the
 * resulting merged settings come back via the `event:settings:changed` push,
 * which `useSettingsBoot` feeds into `hydrate` — so the store is always the
 * mirror of what main persisted, and external file edits flow in too.
 *
 * Stays free of preload coupling at module load: the only `window.hive`
 * access lives inside actions, mirroring `workspaceStore`.
 */

import { create } from 'zustand'

import {
  DEFAULT_SETTINGS,
  type PartialSettings,
  type Settings,
} from '../../../types/settings'

export interface SettingsState {
  /** Merged settings (defaults ← user). Always total. */
  settings: Settings
  /** Raw user override layer (contents of settings.json). */
  user: PartialSettings
  /** Absolute path of settings.json (empty until hydrated). */
  path: string

  /** Replace the store from a freshly-fetched bundle / change event. */
  hydrate: (bundle: {
    settings: Settings
    user?: PartialSettings
    path?: string
  }) => void

  /**
   * Set a single setting. Optimistically updates the local merged view, then
   * persists via `window.hive.settings.update`. The authoritative merged
   * result arrives back through the change subscription.
   */
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void

  /** Replace the entire user override layer (JSON escape hatch). */
  replaceUser: (user: PartialSettings) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  user: {},
  path: '',

  hydrate: (bundle) =>
    set((s) => ({
      settings: bundle.settings,
      user: bundle.user ?? s.user,
      path: bundle.path ?? s.path,
    })),

  set: (key, value) => {
    // Optimistic local update so the UI reacts immediately; main echoes the
    // canonical merged result back through the change subscription.
    set((s) => ({
      settings: { ...s.settings, [key]: value },
      user: { ...s.user, [key]: value },
    }))
    void window.hive?.settings.update({ [key]: value } as PartialSettings)
  },

  replaceUser: (user) => {
    set((s) => ({ ...s, user }))
    void window.hive?.settings.replace(user)
  },
}))

/**
 * Read a single setting outside React (e.g. in a Monaco command callback).
 */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return useSettingsStore.getState().settings[key]
}
