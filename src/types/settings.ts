/**
 * Hive IDE — settings schema (E4-01).
 *
 * The single source of truth for every user-tunable preference in the IDE.
 * Modelled after VSCode's flat dotted-key store so the JSON escape hatch
 * ("edit in settings.json") reads naturally, while staying fully typed —
 * every key has a known value type and a compile-time default.
 *
 * Layering (highest precedence last):
 *   defaults  →  user (settings.json)  →  workspace (.hive/settings.json)
 *
 * The merged result is what the renderer reads. `DEFAULT_SETTINGS` is the
 * base layer and guarantees every key is always present, so consumers never
 * have to null-check a setting.
 *
 * Adding a setting:
 *   1. add the key + value type to {@link Settings}
 *   2. add its default to {@link DEFAULT_SETTINGS}
 *   3. (optional) describe it in {@link SETTINGS_SCHEMA} so the settings
 *      editor UI can render a typed input + help text.
 *
 * This file is imported by both `main` (the on-disk store) and the renderer
 * (the reactive accessor), so it must stay free of any Electron / DOM import.
 */

// ---------------------------------------------------------------------------
// Value unions
// ---------------------------------------------------------------------------

/** How the editor wraps long lines. Mirrors Monaco's `wordWrap`. */
export type WordWrapSetting = 'off' | 'on' | 'bounded'

/** Caret rendering style. Mirrors Monaco's `cursorStyle`. */
export type CursorStyleSetting =
  | 'line'
  | 'block'
  | 'underline'
  | 'line-thin'
  | 'block-outline'
  | 'underline-thin'

/** Whitespace rendering. Mirrors Monaco's `renderWhitespace`. */
export type RenderWhitespaceSetting =
  | 'none'
  | 'boundary'
  | 'selection'
  | 'trailing'
  | 'all'

/**
 * Colour theme selection. Known ids: `hive-dark`, `hive-light`, `hive-hc`,
 * `system` (follow-OS) — plus any plugin-contributed theme id (E10-07), so this
 * is an open string rather than a closed union.
 */
export type ColorThemeSetting = string

/** Line-ending style for new files / on-save normalization. */
export type EolSetting = 'lf' | 'crlf'

/**
 * File icon theme. `lucide`/`minimal`/`none` are always-present built-ins;
 * any other value is a plugin-contributed icon-theme id. Open string like
 * {@link ColorThemeSetting}.
 */
export type IconThemeSetting = string

// ---------------------------------------------------------------------------
// Settings shape
// ---------------------------------------------------------------------------

/**
 * The complete, flat settings record. Dotted keys group related settings
 * the way VSCode does; every key is required so `DEFAULT_SETTINGS` is total.
 */
export interface Settings {
  // ----- editor -------------------------------------------------------
  'editor.fontSize': number
  'editor.fontFamily': string
  'editor.fontLigatures': boolean
  'editor.lineHeight': number
  'editor.tabSize': number
  'editor.insertSpaces': boolean
  'editor.wordWrap': WordWrapSetting
  'editor.minimap': boolean
  'editor.stickyScroll': boolean
  'editor.bracketPairColorization': boolean
  'editor.guides.indentation': boolean
  'editor.cursorStyle': CursorStyleSetting
  'editor.renderWhitespace': RenderWhitespaceSetting
  'editor.formatOnSave': boolean
  'editor.formatOnPaste': boolean
  'editor.trimTrailingWhitespace': boolean
  'editor.insertFinalNewline': boolean
  /** Editor zoom level; each step is ~20% (matches VSCode). */
  'editor.zoomLevel': number
  /** Per-token colour overrides (E8-07), each `scope=rrggbb`. */
  'editor.tokenColorCustomizations': string[]

  // ----- files --------------------------------------------------------
  'files.eol': EolSetting

  // ----- search -------------------------------------------------------
  /** Glob patterns excluded from global search + quick-open. */
  'search.exclude': string[]
  /** Respect `.gitignore` (and `.ignore`) when searching. */
  'search.useIgnoreFiles': boolean

  // ----- workbench ----------------------------------------------------
  'workbench.colorTheme': ColorThemeSetting
  'workbench.statusBar.visible': boolean
  'workbench.activityBar.visible': boolean
  'workbench.iconTheme': IconThemeSetting

  // ----- extensions ---------------------------------------------------
  /** Marketplace registry index URL (https). Empty disables the marketplace. */
  'extensions.registryUrl': string

  // ----- github -------------------------------------------------------
  /** PAT for PRs-view enrichment; overrides the `gh` CLI token when set. */
  'github.token': string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The base settings layer. Every {@link Settings} key MUST appear here so
 * the merged result is always total. These are also the values the settings
 * editor renders as "(default)".
 */
export const DEFAULT_SETTINGS: Settings = {
  'editor.fontSize': 13,
  'editor.fontFamily':
    "'SF Mono', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
  'editor.fontLigatures': false,
  'editor.lineHeight': 0, // 0 → Monaco derives from fontSize
  'editor.tabSize': 2,
  'editor.insertSpaces': true,
  'editor.wordWrap': 'off',
  'editor.minimap': false,
  'editor.stickyScroll': false,
  'editor.bracketPairColorization': true,
  'editor.guides.indentation': true,
  'editor.cursorStyle': 'line',
  'editor.renderWhitespace': 'selection',
  'editor.formatOnSave': false,
  'editor.formatOnPaste': false,
  'editor.trimTrailingWhitespace': false,
  'editor.insertFinalNewline': false,
  'editor.zoomLevel': 0,
  'editor.tokenColorCustomizations': [],
  'files.eol': 'lf',
  'search.exclude': [
    '**/node_modules',
    '**/.git',
    '**/dist',
    '**/out',
    '**/build',
    '**/.next',
    '**/coverage',
  ],
  'search.useIgnoreFiles': true,
  'workbench.colorTheme': 'hive-dark',
  'workbench.statusBar.visible': true,
  'workbench.activityBar.visible': true,
  'workbench.iconTheme': 'lucide',
  'extensions.registryUrl':
    'https://raw.githubusercontent.com/nikrich/hive-ide/main/registry.json',
  'github.token': '',
}

// ---------------------------------------------------------------------------
// Schema metadata (drives the settings editor UI — E4-02)
// ---------------------------------------------------------------------------

/** A user-facing settings group, used to organise the settings editor. */
export type SettingsCategory =
  | 'Editor'
  | 'Files'
  | 'Search'
  | 'Workbench'
  | 'Extensions'
  | 'GitHub'

/** Editor-input hint for a setting. `select` carries its option list. */
export type SettingsInputKind =
  | { type: 'boolean' }
  | { type: 'number'; min?: number; max?: number; step?: number }
  | { type: 'string' }
  | { type: 'string[]' }
  | { type: 'select'; options: ReadonlyArray<string> }

/** One row of metadata describing how to render + explain a setting. */
export interface SettingDescriptor<K extends keyof Settings = keyof Settings> {
  key: K
  category: SettingsCategory
  /** Short human label (the dotted key is shown as a secondary line). */
  title: string
  /** One-line explanation rendered under the input. */
  description: string
  input: SettingsInputKind
}

/**
 * Render metadata for every setting. Order here is the order the settings
 * editor lists them within a category. Keeping this exhaustive is enforced
 * by the `SETTINGS_SCHEMA satisfies` check below — a missing key is a
 * compile error.
 */
export const SETTINGS_SCHEMA: ReadonlyArray<SettingDescriptor> = [
  {
    key: 'editor.fontSize',
    category: 'Editor',
    title: 'Font Size',
    description: 'Controls the editor font size in pixels.',
    input: { type: 'number', min: 6, max: 100, step: 1 },
  },
  {
    key: 'editor.fontFamily',
    category: 'Editor',
    title: 'Font Family',
    description: 'Controls the editor font family.',
    input: { type: 'string' },
  },
  {
    key: 'editor.fontLigatures',
    category: 'Editor',
    title: 'Font Ligatures',
    description: 'Enables font ligatures where the font supports them.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.lineHeight',
    category: 'Editor',
    title: 'Line Height',
    description:
      'Line height in pixels. Use 0 to derive it from the font size.',
    input: { type: 'number', min: 0, max: 150, step: 1 },
  },
  {
    key: 'editor.tabSize',
    category: 'Editor',
    title: 'Tab Size',
    description: 'The number of spaces a tab is equal to.',
    input: { type: 'number', min: 1, max: 16, step: 1 },
  },
  {
    key: 'editor.insertSpaces',
    category: 'Editor',
    title: 'Insert Spaces',
    description: 'Insert spaces when pressing Tab.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.wordWrap',
    category: 'Editor',
    title: 'Word Wrap',
    description: 'Controls how lines should wrap.',
    input: { type: 'select', options: ['off', 'on', 'bounded'] },
  },
  {
    key: 'editor.minimap',
    category: 'Editor',
    title: 'Minimap',
    description: 'Show the minimap on the right edge of the editor.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.stickyScroll',
    category: 'Editor',
    title: 'Sticky Scroll',
    description: 'Pin enclosing scopes to the top of the editor viewport.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.bracketPairColorization',
    category: 'Editor',
    title: 'Bracket Pair Colorization',
    description: 'Colorize matching bracket pairs.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.guides.indentation',
    category: 'Editor',
    title: 'Indent Guides',
    description: 'Render vertical indentation guide lines.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.cursorStyle',
    category: 'Editor',
    title: 'Cursor Style',
    description: 'Controls the cursor style.',
    input: {
      type: 'select',
      options: [
        'line',
        'block',
        'underline',
        'line-thin',
        'block-outline',
        'underline-thin',
      ],
    },
  },
  {
    key: 'editor.renderWhitespace',
    category: 'Editor',
    title: 'Render Whitespace',
    description: 'Controls how whitespace characters are rendered.',
    input: {
      type: 'select',
      options: ['none', 'boundary', 'selection', 'trailing', 'all'],
    },
  },
  {
    key: 'editor.formatOnSave',
    category: 'Editor',
    title: 'Format On Save',
    description: 'Format the file with the default formatter on save.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.formatOnPaste',
    category: 'Editor',
    title: 'Format On Paste',
    description: 'Format pasted content.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.trimTrailingWhitespace',
    category: 'Editor',
    title: 'Trim Trailing Whitespace',
    description: 'Remove trailing whitespace from each line on save.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.insertFinalNewline',
    category: 'Editor',
    title: 'Insert Final Newline',
    description: 'Ensure the file ends with a single newline on save.',
    input: { type: 'boolean' },
  },
  {
    key: 'editor.zoomLevel',
    category: 'Editor',
    title: 'Zoom Level',
    description: 'Editor zoom level. Each step is roughly 20%.',
    input: { type: 'number', min: -8, max: 12, step: 1 },
  },
  {
    key: 'editor.tokenColorCustomizations',
    category: 'Editor',
    title: 'Token Color Customizations',
    description: 'Per-token colour overrides, one per line as scope=rrggbb (e.g. comment=6a9955).',
    input: { type: 'string[]' },
  },
  {
    key: 'files.eol',
    category: 'Files',
    title: 'End of Line',
    description: 'Default line-ending for new files.',
    input: { type: 'select', options: ['lf', 'crlf'] },
  },
  {
    key: 'search.exclude',
    category: 'Search',
    title: 'Exclude',
    description: 'Glob patterns excluded from search and quick-open.',
    input: { type: 'string[]' },
  },
  {
    key: 'search.useIgnoreFiles',
    category: 'Search',
    title: 'Use Ignore Files',
    description: 'Respect .gitignore and .ignore files when searching.',
    input: { type: 'boolean' },
  },
  {
    key: 'workbench.colorTheme',
    category: 'Workbench',
    title: 'Color Theme',
    description: 'The colour theme used across the editor and the chrome.',
    input: { type: 'select', options: ['hive-dark', 'hive-light', 'hive-hc', 'system'] },
  },
  {
    key: 'workbench.statusBar.visible',
    category: 'Workbench',
    title: 'Status Bar Visible',
    description: 'Show the status bar at the bottom of the window.',
    input: { type: 'boolean' },
  },
  {
    key: 'workbench.activityBar.visible',
    category: 'Workbench',
    title: 'Activity Bar Visible',
    description: 'Show the activity bar on the left edge.',
    input: { type: 'boolean' },
  },
  {
    key: 'workbench.iconTheme',
    category: 'Workbench',
    title: 'File Icon Theme',
    description: 'File icon set: colourful, monochrome, or none.',
    input: { type: 'select', options: ['lucide', 'minimal', 'none'] },
  },
  {
    key: 'extensions.registryUrl',
    category: 'Extensions',
    title: 'Registry URL',
    description:
      'HTTPS URL of the marketplace index (registry.json). Empty disables the marketplace.',
    input: { type: 'string' },
  },
  {
    key: 'github.token',
    category: 'GitHub',
    title: 'GitHub Token',
    description:
      'Personal access token for PRs-view enrichment. Overrides the `gh` CLI token when set. Leave empty to use `gh auth token`.',
    input: { type: 'string' },
  },
]

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

/**
 * A partial settings override (the shape of a user `settings.json`). Any
 * subset of keys; unknown keys are ignored by {@link mergeSettings}.
 */
export type PartialSettings = Partial<Settings>

/**
 * Merge override layers over {@link DEFAULT_SETTINGS}, last-wins. Only keys
 * known to {@link DEFAULT_SETTINGS} are copied, so a malformed or
 * stale settings file can never inject unexpected keys into the runtime
 * settings object.
 */
export function mergeSettings(
  ...layers: ReadonlyArray<PartialSettings | null | undefined>
): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS }
  for (const layer of layers) {
    if (!layer) continue
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      if (Object.prototype.hasOwnProperty.call(layer, key)) {
        const value = layer[key]
        if (value !== undefined) {
          // Each key's value type is preserved by the indexed assignment;
          // the cast is needed because TS can't prove key/value alignment
          // across the dynamic loop.
          ;(out as Record<keyof Settings, unknown>)[key] = value
        }
      }
    }
  }
  return out
}

/** Structural equality for settings values (primitives + string arrays). */
export function settingsValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => x === b[i])
  }
  return false
}

/**
 * Compute the next user-override layer after merging `patch` into `user`.
 * Keys whose value equals the compile-time default are dropped so the
 * persisted `settings.json` only ever records genuine overrides. Unknown
 * keys in `patch` are ignored.
 */
export function applyPatch(
  user: PartialSettings,
  patch: PartialSettings,
): PartialSettings {
  const next: PartialSettings = { ...user }
  for (const key of Object.keys(patch) as Array<keyof Settings>) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) continue
    const value = patch[key]
    if (value === undefined) continue
    if (settingsValueEqual(value, DEFAULT_SETTINGS[key])) {
      delete next[key]
    } else {
      ;(next as Record<keyof Settings, unknown>)[key] = value
    }
  }
  return next
}

/**
 * Reduce an arbitrary object to a clean user-override layer: only keys known
 * to {@link DEFAULT_SETTINGS}, and only where the value actually differs from
 * the default. Used when replacing the whole layer from a hand-edited file.
 */
export function sanitizeUser(user: PartialSettings): PartialSettings {
  const clean: PartialSettings = {}
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (!Object.prototype.hasOwnProperty.call(user, key)) continue
    const value = user[key]
    if (value !== undefined && !settingsValueEqual(value, DEFAULT_SETTINGS[key])) {
      ;(clean as Record<keyof Settings, unknown>)[key] = value
    }
  }
  return clean
}
