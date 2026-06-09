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
import type { PluginConfigProperty } from '../../../types/workspace'

/** A plugin-contributed setting (E10-05). */
export interface PluginSettingEntry {
  /** Dotted setting id, e.g. `mylang.format.indent`. */
  key: string
  /** Owning plugin id (for grouping). */
  pluginId: string
  property: PluginConfigProperty
}

const EXTRA_KEY = 'hive.settings.extra'

function loadExtra(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(EXTRA_KEY)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

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

  // ----- plugin-contributed settings (E10-05) ---------------------------

  /** Plugin setting schema (registered when enabled plugins change). */
  pluginSchema: PluginSettingEntry[]
  /** Defaults from plugin schemas, keyed by setting id. */
  pluginDefaults: Record<string, unknown>
  /** User overrides for plugin settings, keyed by setting id (persisted). */
  pluginExtra: Record<string, unknown>
  /** Register the plugin setting schema + defaults. */
  setPluginConfig: (
    schema: PluginSettingEntry[],
    defaults: Record<string, unknown>,
  ) => void
  /** Read a plugin setting's effective value (override ?? default). */
  getExtra: (key: string) => unknown
  /** Set a plugin setting override; persisted to localStorage. */
  setExtra: (key: string, value: unknown) => void
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

  pluginSchema: [],
  pluginDefaults: {},
  pluginExtra: loadExtra(),
  setPluginConfig: (schema, defaults) =>
    set(() => ({ pluginSchema: schema, pluginDefaults: defaults })),
  getExtra: (key) => {
    const s = get()
    return key in s.pluginExtra ? s.pluginExtra[key] : s.pluginDefaults[key]
  },
  setExtra: (key, value) =>
    set((s) => {
      const pluginExtra = { ...s.pluginExtra, [key]: value }
      try {
        localStorage.setItem(EXTRA_KEY, JSON.stringify(pluginExtra))
      } catch {
        // storage unavailable; non-fatal
      }
      return { pluginExtra }
    }),
}))

/**
 * Read a single setting outside React (e.g. in a Monaco command callback).
 */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return useSettingsStore.getState().settings[key]
}
