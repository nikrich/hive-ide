/**
 * Keyboard chord tests (E4-03).
 */

import { describe, expect, it } from 'vitest'

import { chordFromEvent, formatChord, type ChordEvent } from './keys'

const ev = (over: Partial<ChordEvent>): ChordEvent => ({
  key: 'a',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
})

describe('chordFromEvent', () => {
  it('maps Cmd to mod on macOS', () => {
    expect(chordFromEvent(ev({ key: 'f', metaKey: true }), 'darwin')).toBe(
      'mod+f',
    )
  })

  it('maps Ctrl to mod on win/linux', () => {
    expect(chordFromEvent(ev({ key: 'f', ctrlKey: true }), 'win32')).toBe(
      'mod+f',
    )
  })

  it('keeps literal Ctrl distinct from mod on macOS', () => {
    expect(chordFromEvent(ev({ key: 'f', ctrlKey: true }), 'darwin')).toBe(
      'ctrl+f',
    )
  })

  it('orders modifiers mod, ctrl, alt, shift', () => {
    expect(
      chordFromEvent(
        ev({ key: 'p', metaKey: true, altKey: true, shiftKey: true }),
        'darwin',
      ),
    ).toBe('mod+alt+shift+p')
  })

  it('normalizes special keys', () => {
    expect(chordFromEvent(ev({ key: 'Escape' }), 'darwin')).toBe('escape')
    expect(chordFromEvent(ev({ key: 'ArrowUp' }), 'darwin')).toBe('up')
    expect(chordFromEvent(ev({ key: ' ', metaKey: true }), 'darwin')).toBe(
      'mod+space',
    )
    expect(chordFromEvent(ev({ key: 'F2' }), 'darwin')).toBe('f2')
  })

  it('returns null for a lone modifier press', () => {
    expect(chordFromEvent(ev({ key: 'Shift', shiftKey: true }), 'darwin')).toBe(
      null,
    )
    expect(chordFromEvent(ev({ key: 'Meta', metaKey: true }), 'darwin')).toBe(
      null,
    )
  })
})

describe('formatChord', () => {
  it('renders mac glyphs', () => {
    expect(formatChord('mod+shift+p', 'darwin')).toBe('⌘⇧P')
    expect(formatChord('mod+f', 'darwin')).toBe('⌘F')
    expect(formatChord('escape', 'darwin')).toBe('Esc')
  })

  it('renders PC labels', () => {
    expect(formatChord('mod+shift+p', 'win32')).toBe('Ctrl+Shift+P')
    expect(formatChord('mod+f', 'linux')).toBe('Ctrl+F')
  })

  it('renders a chord sequence', () => {
    expect(formatChord('mod+k mod+s', 'darwin')).toBe('⌘K ⌘S')
  })
})
