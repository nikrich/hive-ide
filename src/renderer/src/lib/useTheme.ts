/**
 * Theme resolution hook (E8-03).
 *
 * Watches the `workbench.colorTheme` setting and the OS colour-scheme media
 * query, collapses them to a concrete theme id, and writes it into the theme
 * store. App reflects that into the shell's `data-theme` attribute and Monaco
 * picks it up via its theme prop — so a setting change (or an OS appearance
 * switch while on "system") re-themes everything live.
 */

import { useEffect } from 'react'

import { useSettingsStore } from '../store/settingsStore'
import { useThemeStore } from '../store/themeStore'
import { resolveThemeId } from './themes'

export function useTheme(): void {
  const setting = useSettingsStore((s) => s.settings['workbench.colorTheme'])
  const setResolved = useThemeStore((s) => s.setResolved)

  useEffect(() => {
    const mq =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null

    const apply = (): void => {
      setResolved(resolveThemeId(setting, mq ? mq.matches : true))
    }
    apply()

    if (setting === 'system' && mq) {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [setting, setResolved])
}
