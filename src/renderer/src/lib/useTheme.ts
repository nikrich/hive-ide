/**
 * Theme resolution hook (E8-03, E10-07).
 *
 * Watches `workbench.colorTheme` + the OS colour-scheme media query and
 * resolves them into a Monaco theme id + a chrome bucket, written to the theme
 * store. Handles `system` (follow-OS), the base themes, and plugin-contributed
 * themes (falling back to dark when an unknown id is selected).
 */

import { useEffect } from 'react'

import { useSettingsStore } from '../store/settingsStore'
import { useThemeStore } from '../store/themeStore'
import {
  chromeFor,
  isKnownTheme,
  parseTokenRules,
  resolveThemeId,
  setTokenCustomizations,
} from './themes'

export function useTheme(): void {
  const setting = useSettingsStore((s) => s.settings['workbench.colorTheme'])
  const tokenColors = useSettingsStore((s) => s.settings['editor.tokenColorCustomizations'])
  const monacoTheme = useThemeStore((s) => s.monacoTheme)
  const setResolved = useThemeStore((s) => s.setResolved)

  // Apply per-token colour overrides (E8-07) whenever they change.
  useEffect(() => {
    setTokenCustomizations(parseTokenRules(tokenColors), monacoTheme)
  }, [tokenColors, monacoTheme])

  useEffect(() => {
    const mq =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null

    const apply = (): void => {
      let monacoTheme: string
      if (setting === 'system') {
        monacoTheme = resolveThemeId('system', mq ? mq.matches : true)
      } else if (isKnownTheme(setting)) {
        monacoTheme = setting
      } else {
        // Setting names a base id not yet in the registry, or an unknown id.
        monacoTheme = setting === 'hive-light' || setting === 'hive-hc' ? setting : 'hive-dark'
      }
      setResolved(monacoTheme, chromeFor(monacoTheme))
    }
    apply()

    if (setting === 'system' && mq) {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [setting, setResolved])
}
