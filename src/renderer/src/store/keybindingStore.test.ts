/**
 * Keybinding resolution tests (E4-03).
 */

import { describe, expect, it } from 'vitest'

import { resolveChord, type Keybinding } from './keybindingStore'

const def = (key: string, command: string, when?: string): Keybinding => ({
  key,
  command,
  when,
  source: 'default',
})
const usr = (key: string, command: string, when?: string): Keybinding => ({
  key,
  command,
  when,
  source: 'user',
})
const con = (key: string, command: string): Keybinding => ({
  key,
  command,
  source: 'contributed',
})

describe('resolveChord', () => {
  it('returns the bound command for a matching chord', () => {
    const match = resolveChord('mod+f', {}, [def('mod+f', 'find')])
    expect(match?.command).toBe('find')
  })

  it('returns null when nothing is bound', () => {
    expect(resolveChord('mod+f', {}, [def('mod+g', 'x')])).toBeNull()
  })

  it('respects when-clauses', () => {
    const bindings = [def('mod+f', 'find', 'editorFocus')]
    expect(resolveChord('mod+f', { editorFocus: false }, bindings)).toBeNull()
    expect(resolveChord('mod+f', { editorFocus: true }, bindings)?.command).toBe(
      'find',
    )
  })

  it('lets the user layer override a default', () => {
    const match = resolveChord('mod+f', {}, [
      def('mod+f', 'defaultFind'),
      usr('mod+f', 'userFind'),
    ])
    expect(match?.command).toBe('userFind')
  })

  it('treats an empty command as an explicit unbind', () => {
    const match = resolveChord('mod+f', {}, [
      def('mod+f', 'defaultFind'),
      usr('mod+f', ''),
    ])
    expect(match).toBeNull()
  })

  it('orders precedence user > contributed > default', () => {
    expect(
      resolveChord('mod+f', {}, [
        def('mod+f', 'd'),
        con('mod+f', 'c'),
      ])?.command,
    ).toBe('c')
    expect(
      resolveChord('mod+f', {}, [
        def('mod+f', 'd'),
        con('mod+f', 'c'),
        usr('mod+f', 'u'),
      ])?.command,
    ).toBe('u')
  })

  it('last-registered wins within the same layer', () => {
    const match = resolveChord('mod+f', {}, [
      def('mod+f', 'first'),
      def('mod+f', 'second'),
    ])
    expect(match?.command).toBe('second')
  })
})
