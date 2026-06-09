/**
 * Keyboard chord normalization + formatting (E4-03).
 *
 * Bindings in the registry are stored as platform-neutral chord strings using
 * a fixed canonical form:
 *
 *   modifiers, in order: `mod`, `ctrl`, `alt`, `shift`, then the key.
 *   e.g.  'mod+shift+p', 'mod+f', 'f2', 'escape', 'mod+k mod+s' (a sequence)
 *
 * `mod` is the platform's primary accelerator — Cmd on macOS, Ctrl elsewhere.
 * `ctrl` is the literal Control key (only distinct from `mod` on macOS).
 *
 * `chordFromEvent` converts a DOM KeyboardEvent into this form so it can be
 * looked up against the registry; `formatChord` renders it for display
 * (⌘⇧P on mac, Ctrl+Shift+P on win/linux).
 */

export type Platform = 'darwin' | 'win32' | 'linux' | string

/** Map a raw `KeyboardEvent.key` to a stable lowercase chord segment. */
function normalizeKey(key: string): string {
  switch (key) {
    case ' ':
      return 'space'
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    case 'Escape':
      return 'escape'
    case 'Enter':
      return 'enter'
    case 'Tab':
      return 'tab'
    case 'Backspace':
      return 'backspace'
    case 'Delete':
      return 'delete'
    default:
      return key.toLowerCase()
  }
}

/** True when `key` names a modifier (so it can't be the chord's main key). */
function isModifierKey(key: string): boolean {
  return (
    key === 'Shift' ||
    key === 'Control' ||
    key === 'Alt' ||
    key === 'Meta' ||
    key === 'CapsLock' ||
    key === 'AltGraph'
  )
}

export interface ChordEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * Convert a keyboard event into a canonical chord string, or `null` when the
 * event is a lone modifier press (nothing to bind to yet).
 */
export function chordFromEvent(
  event: ChordEvent,
  platform: Platform,
): string | null {
  if (isModifierKey(event.key)) return null

  const parts: string[] = []
  const isMac = platform === 'darwin'

  if (isMac) {
    if (event.metaKey) parts.push('mod')
    if (event.ctrlKey) parts.push('ctrl')
  } else {
    // On win/linux the primary accelerator is Ctrl, so it maps to `mod`.
    if (event.ctrlKey) parts.push('mod')
    if (event.metaKey) parts.push('meta')
  }
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')

  parts.push(normalizeKey(event.key))
  return parts.join('+')
}

/**
 * Normalize a human-written chord (e.g. `Ctrl+Alt+T`, `cmd+shift+p`) into the
 * canonical registry form. Used for plugin-contributed keybindings (E10-04).
 * `forMac` controls how Ctrl/Cmd collapse onto `mod`:
 *   - mac: `cmd`/`command`/`meta` → `mod`; `ctrl` stays literal `ctrl`.
 *   - other: `ctrl`/`control` → `mod`; `meta`/`win` → `meta`.
 */
export function normalizeChord(raw: string, forMac: boolean): string {
  const tokens = raw
    .split('+')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  if (tokens.length === 0) return ''
  const key = tokens[tokens.length - 1]
  const mods = new Set<string>()
  for (const t of tokens.slice(0, -1)) {
    if (t === 'cmd' || t === 'command' || t === 'meta' || t === 'super') {
      mods.add(forMac ? 'mod' : 'meta')
    } else if (t === 'ctrl' || t === 'control') {
      mods.add(forMac ? 'ctrl' : 'mod')
    } else if (t === 'alt' || t === 'option' || t === 'opt') {
      mods.add('alt')
    } else if (t === 'shift') {
      mods.add('shift')
    } else if (t === 'win') {
      mods.add('meta')
    }
  }
  const order = ['mod', 'ctrl', 'alt', 'shift', 'meta']
  const ordered = order.filter((m) => mods.has(m))
  return [...ordered, normalizeKey(key)].join('+')
}

const MAC_SYMBOLS: Record<string, string> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
}

const PC_LABELS: Record<string, string> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Win',
}

/** Pretty-print a single chord segment's main key. */
function prettyKey(key: string): string {
  switch (key) {
    case 'escape':
      return 'Esc'
    case 'space':
      return 'Space'
    case 'up':
      return '↑'
    case 'down':
      return '↓'
    case 'left':
      return '←'
    case 'right':
      return '→'
    case 'enter':
      return '↵'
    default:
      return key.length === 1 ? key.toUpperCase() : capitalize(key)
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Render a chord (possibly a space-separated sequence) for display. macOS uses
 * symbol glyphs with no separator (⌘⇧P); other platforms use `Ctrl+Shift+P`.
 */
export function formatChord(chord: string, platform: Platform): string {
  const isMac = platform === 'darwin'
  return chord
    .split(' ')
    .map((single) => {
      const segs = single.split('+')
      const key = segs[segs.length - 1]
      const mods = segs.slice(0, -1)
      if (isMac) {
        return mods.map((m) => MAC_SYMBOLS[m] ?? m).join('') + prettyKey(key)
      }
      return [...mods.map((m) => PC_LABELS[m] ?? capitalize(m)), prettyKey(key)].join(
        '+',
      )
    })
    .join(' ')
}
