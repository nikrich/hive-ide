/**
 * Resolved theme store (E8).
 *
 * Holds the concrete theme id (`hive-dark` / `hive-light`) after collapsing the
 * `workbench.colorTheme` setting + OS preference. App applies it as a
 * `data-theme` attribute on the shell; MonacoEditor reads it for its theme
 * prop. Kept tiny + separate so both can subscribe without a render loop.
 */

import { create } from 'zustand'

import type { ConcreteThemeId } from '../lib/themes'

export interface ThemeState {
  resolved: ConcreteThemeId
  setResolved: (id: ConcreteThemeId) => void
}

export const useThemeStore = create<ThemeState>((set) => ({
  resolved: 'hive-dark',
  setResolved: (id) => set((s) => (s.resolved === id ? {} : { resolved: id })),
}))
