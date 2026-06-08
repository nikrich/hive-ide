/**
 * Theme system (E8-01..E8-03).
 *
 * A theme is a single source of truth that drives BOTH the app chrome (via a
 * `data-theme` attribute on the shell, which CSS keys its semantic-token
 * overrides off) AND the Monaco editor (a registered Monaco theme). Switching
 * re-themes editor + chrome with no reload.
 *
 * `workbench.colorTheme` selects `hive-dark`, `hive-light`, or `system`
 * (follow-OS). `resolveThemeId` collapses `system` to a concrete id using the
 * OS preference. `installMonacoThemes` registers the two concrete Monaco
 * themes (idempotent).
 */

import type * as Monaco from 'monaco-editor'

import type { ColorThemeSetting } from '../../../types/settings'

export type ConcreteThemeId = 'hive-dark' | 'hive-light' | 'hive-hc'

export interface ThemeChoice {
  id: ColorThemeSetting
  label: string
}

/** Themes offered by the switcher (E8-03, E8-05). */
export const THEME_CHOICES: ReadonlyArray<ThemeChoice> = [
  { id: 'hive-dark', label: 'Hive Dark' },
  { id: 'hive-light', label: 'Hive Light' },
  { id: 'hive-hc', label: 'Hive High Contrast' },
  { id: 'system', label: 'System (follow OS)' },
]

/** Resolve the setting to a concrete theme id using the OS preference. */
export function resolveThemeId(
  setting: ColorThemeSetting,
  prefersDark: boolean,
): ConcreteThemeId {
  if (setting === 'system') return prefersDark ? 'hive-dark' : 'hive-light'
  return setting
}

let themesInstalled = false

/** Register the concrete Monaco themes. Idempotent. */
export function installMonacoThemes(monaco: typeof Monaco): void {
  if (themesInstalled) return
  themesInstalled = true

  monaco.editor.defineTheme('hive-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#060A14',
      'editor.foreground': '#F1F5F9',
      'editorLineNumber.foreground': '#475569',
      'editorLineNumber.activeForeground': '#94A3B8',
      'editorGutter.background': '#060A14',
      'editor.selectionBackground': '#28344d',
      'editor.lineHighlightBackground': '#0f1626',
      'editorCursor.foreground': '#818cf8',
      'editorIndentGuide.background1': '#1e293b',
    },
  })

  monaco.editor.defineTheme('hive-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#1E293B',
      'editorLineNumber.foreground': '#94A3B8',
      'editorLineNumber.activeForeground': '#475569',
      'editor.selectionBackground': '#c7d2fe',
      'editor.lineHighlightBackground': '#f1f5f9',
      'editorCursor.foreground': '#4f46e5',
      'editorIndentGuide.background1': '#e2e8f0',
    },
  })

  // High-contrast (E8-05) — pure-black background, bright foreground.
  monaco.editor.defineTheme('hive-hc', {
    base: 'hc-black',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#000000',
      'editor.foreground': '#FFFFFF',
      'editorCursor.foreground': '#FFFFFF',
      'editor.selectionBackground': '#FFFFFF40',
    },
  })
}
