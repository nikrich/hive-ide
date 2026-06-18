/**
 * Active file-icon theme state. Built-in themes (`lucide`/`minimal`/`none`)
 * use the lucide mapping in fileIcon.ts and need no async loading. A
 * plugin-contributed theme id triggers a one-time load of its JSON + SVGs via
 * `plugins:read-asset`; SVGs are cached as `data:` URLs (no Blob/objectURL, so
 * this works in any environment). `version` bumps whenever a load completes so
 * subscribed icons re-render and upgrade from their lucide fallback.
 */
import { create } from 'zustand'

import type { LoadedPlugin } from '../../../types/workspace'
import {
  normalizeIconTheme,
  type NormalizedIconTheme,
} from '../lib/iconThemeDoc'

export const BUILTIN_ICON_THEMES = ['lucide', 'minimal', 'none'] as const

export interface IconThemeRegistryEntry {
  pluginId: string
  themePath: string
  /** Human-readable label for the picker. */
  label: string
}

/** themeId → owning plugin + plugin-relative JSON path. */
export type IconThemeRegistry = Record<string, IconThemeRegistryEntry>

/** Pure: collect contributed icon themes from valid plugins. */
export function buildIconThemeRegistry(
  plugins: readonly LoadedPlugin[],
): IconThemeRegistry {
  const reg: IconThemeRegistry = {}
  for (const p of plugins) {
    if (!p.valid) continue
    for (const t of p.manifest.contributes?.iconThemes ?? []) {
      reg[t.id] = { pluginId: p.manifest.id, themePath: t.path, label: t.label }
    }
  }
  return reg
}

/** Join a plugin-relative theme-JSON dir with an iconPath from that JSON. */
export function resolveAssetRelPath(themePath: string, iconPath: string): string {
  const dir = themePath.replace(/[^/]*$/, '') // strip filename
  const joined = (dir + iconPath).replace(/^\.\//, '')
  const segs: string[] = []
  for (const s of joined.split('/')) {
    if (s === '.' || s === '') continue
    if (s === '..') segs.pop()
    else segs.push(s)
  }
  return segs.join('/')
}

function svgDataUrl(text: string): string {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(text)
}

const inFlight = new Set<string>()

interface IconThemeState {
  activeId: string
  registry: IconThemeRegistry
  doc: NormalizedIconTheme | null
  /** definitionId → data: URL (resolved SVGs only). */
  svgs: Record<string, string>
  /** definitionIds that failed to load — don't retry in a tight loop. */
  failed: Set<string>
  version: number
  setRegistry: (plugins: readonly LoadedPlugin[]) => void
  setActive: (id: string) => void
  /** Look up a resolved SVG; kicks off a load on first miss. Returns url|null. */
  svgForDef: (defId: string, iconPath: string | undefined) => string | null
}

export const useIconThemeStore = create<IconThemeState>((set, get) => ({
  activeId: 'lucide',
  registry: {},
  doc: null,
  svgs: {},
  failed: new Set(),
  version: 0,

  setRegistry: (plugins) => {
    set({ registry: buildIconThemeRegistry(plugins) })
    // If the active theme just became available/unavailable, reload it.
    get().setActive(get().activeId)
  },

  setActive: (id) => {
    const isBuiltin = (BUILTIN_ICON_THEMES as readonly string[]).includes(id)
    if (isBuiltin || get().registry[id] === undefined) {
      set({ activeId: id, doc: null, svgs: {}, failed: new Set() })
      set((s) => ({ version: s.version + 1 }))
      return
    }
    const entry = get().registry[id]
    set({ activeId: id, doc: null, svgs: {}, failed: new Set() })
    const bridge = window.hive?.plugins
    if (!bridge) return
    void bridge
      .readAsset(entry.pluginId, entry.themePath)
      .then((text) => {
        if (get().activeId !== id) return // superseded
        set({ doc: normalizeIconTheme(JSON.parse(text)) })
        set((s) => ({ version: s.version + 1 }))
      })
      .catch(() => {
        /* leave doc null → lucide fallback everywhere */
      })
  },

  svgForDef: (defId, iconPath) => {
    const s = get()
    const cached = s.svgs[defId]
    if (cached) return cached
    if (s.failed.has(defId) || !iconPath || s.doc === null) return null
    const entry = s.registry[s.activeId]
    const bridge = window.hive?.plugins
    if (!entry || !bridge) return null
    const themeAtStart = s.activeId
    const key = themeAtStart + '::' + defId
    if (!inFlight.has(key)) {
      inFlight.add(key)
      const relPath = resolveAssetRelPath(entry.themePath, iconPath)
      void bridge
        .readAsset(entry.pluginId, relPath)
        .then((text) => {
          inFlight.delete(key)
          // Drop the result if the active theme changed mid-load — otherwise a
          // stale SVG could land in the new theme's cache under a shared defId.
          if (get().activeId !== themeAtStart) return
          set((st) => ({
            svgs: { ...st.svgs, [defId]: svgDataUrl(text) },
            version: st.version + 1,
          }))
        })
        .catch(() => {
          inFlight.delete(key)
          if (get().activeId !== themeAtStart) return
          set((st) => {
            const failed = new Set(st.failed)
            failed.add(defId)
            return { failed }
          })
        })
    }
    return null
  },
}))
