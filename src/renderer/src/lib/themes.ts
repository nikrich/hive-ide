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

/** Resolve the setting to a concrete base theme id using the OS preference. */
export function resolveThemeId(
  setting: ColorThemeSetting,
  prefersDark: boolean,
): ConcreteThemeId {
  if (setting === 'system') return prefersDark ? 'hive-dark' : 'hive-light'
  if (setting === 'hive-light' || setting === 'hive-hc') return setting
  return 'hive-dark'
}

/** A theme registered at runtime (built-in or plugin-contributed, E10-07). */
export interface RegisteredTheme {
  id: string
  label: string
  type: 'dark' | 'light' | 'hc'
  monaco: Monaco.editor.IStandaloneThemeData
}

const themeRegistry = new Map<string, RegisteredTheme>()
let monacoRef: typeof Monaco | null = null
/** User per-token colour overrides applied on top of every theme (E8-07). */
let customRules: Monaco.editor.ITokenThemeRule[] = []

/** Define one theme with the user's token overrides merged on top. */
function defineTheme(monaco: typeof Monaco, t: RegisteredTheme): void {
  monaco.editor.defineTheme(t.id, {
    ...t.monaco,
    rules: [...t.monaco.rules, ...customRules],
  })
}

/** Register a theme; defines it in Monaco immediately if Monaco is loaded. */
export function registerTheme(theme: RegisteredTheme): void {
  themeRegistry.set(theme.id, theme)
  if (monacoRef) defineTheme(monacoRef, theme)
}

/**
 * Apply per-token colour overrides (E8-07) and re-define every theme so the new
 * rules take effect live. `rules` are TextMate-style `{ token, foreground }`.
 */
export function setTokenCustomizations(
  rules: Monaco.editor.ITokenThemeRule[],
  activeThemeId?: string,
): void {
  customRules = rules
  const monaco = monacoRef
  if (!monaco) return
  for (const t of themeRegistry.values()) defineTheme(monaco, t)
  // Re-assert the active theme so Monaco repaints with the new rules.
  if (activeThemeId) monaco.editor.setTheme(activeThemeId)
}

/** Parse `scope=#rrggbb` lines into Monaco token rules (E8-07). */
export function parseTokenRules(lines: ReadonlyArray<string>): Monaco.editor.ITokenThemeRule[] {
  const out: Monaco.editor.ITokenThemeRule[] = []
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const token = line.slice(0, eq).trim()
    const color = line.slice(eq + 1).trim().replace(/^#/, '')
    if (token && /^[0-9a-fA-F]{6}$/.test(color)) out.push({ token, foreground: color })
  }
  return out
}

/** All registered themes — used by the theme switcher (E8-03). */
export function allThemes(): RegisteredTheme[] {
  return [...themeRegistry.values()]
}

/** Map a (possibly plugin) theme id to its base chrome bucket for CSS tokens. */
export function chromeFor(id: string): ConcreteThemeId {
  if (id === 'hive-light') return 'hive-light'
  if (id === 'hive-hc') return 'hive-hc'
  const t = themeRegistry.get(id)
  if (t) return t.type === 'light' ? 'hive-light' : t.type === 'hc' ? 'hive-hc' : 'hive-dark'
  return 'hive-dark'
}

/** True when `id` is a registered theme (built-in or contributed). */
export function isKnownTheme(id: string): boolean {
  return themeRegistry.has(id)
}

/** The shipped base themes (E8-01/02/05). */
const BASE_THEMES: ReadonlyArray<RegisteredTheme> = [
  {
    id: 'hive-dark',
    label: 'Hive Dark',
    type: 'dark',
    monaco: {
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
    },
  },
  {
    id: 'hive-light',
    label: 'Hive Light',
    type: 'light',
    monaco: {
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
    },
  },
  {
    id: 'hive-hc',
    label: 'Hive High Contrast',
    type: 'hc',
    monaco: {
      base: 'hc-black',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#000000',
        'editor.foreground': '#FFFFFF',
        'editorCursor.foreground': '#FFFFFF',
        'editor.selectionBackground': '#FFFFFF40',
      },
    },
  },
]

// Seed the registry with the base themes at module load.
for (const t of BASE_THEMES) themeRegistry.set(t.id, t)

let themesInstalled = false

/** Define every registered Monaco theme. Idempotent + re-runnable. */
export function installMonacoThemes(monaco: typeof Monaco): void {
  monacoRef = monaco
  for (const t of themeRegistry.values()) defineTheme(monaco, t)
  themesInstalled = true
}

/** Whether Monaco themes have been installed at least once. */
export function themesReady(): boolean {
  return themesInstalled
}
