/**
 * Resolved theme store (E8, E10-07).
 *
 * Holds two resolved values:
 *   - `monacoTheme` — the actual Monaco theme id to apply (may be a
 *     plugin-contributed theme).
 *   - `chrome` — the base bucket (`hive-dark` / `hive-light` / `hive-hc`) the
 *     app chrome CSS keys its tokens off via `data-theme`.
 *
 * Both are derived from `workbench.colorTheme` + the OS preference by
 * `useTheme`. App applies `chrome`; MonacoEditor/DiffView apply `monacoTheme`.
 */

import { create } from 'zustand'

import type { ConcreteThemeId } from '../lib/themes'

export interface ThemeState {
  monacoTheme: string
  chrome: ConcreteThemeId
  setResolved: (monacoTheme: string, chrome: ConcreteThemeId) => void
}

export const useThemeStore = create<ThemeState>((set) => ({
  monacoTheme: 'hive-dark',
  chrome: 'hive-dark',
  setResolved: (monacoTheme, chrome) =>
    set((s) =>
      s.monacoTheme === monacoTheme && s.chrome === chrome
        ? {}
        : { monacoTheme, chrome },
    ),
}))
