/**
 * Settings merge-logic tests (E4-01).
 *
 * Covers the pure functions the on-disk store relies on: merging layers over
 * defaults, applying a patch while dropping default-valued keys, and
 * sanitising an arbitrary (possibly hand-edited) object into a clean
 * override layer.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  applyPatch,
  mergeSettings,
  sanitizeUser,
  settingsValueEqual,
} from './settings'

describe('mergeSettings', () => {
  it('returns the defaults when no layers are given', () => {
    expect(mergeSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns a fresh object (not the DEFAULT_SETTINGS reference)', () => {
    const merged = mergeSettings()
    expect(merged).not.toBe(DEFAULT_SETTINGS)
  })

  it('overrides defaults with a user layer, last-wins', () => {
    const merged = mergeSettings(
      { 'editor.minimap': true },
      { 'editor.minimap': false, 'editor.fontSize': 18 },
    )
    expect(merged['editor.minimap']).toBe(false)
    expect(merged['editor.fontSize']).toBe(18)
  })

  it('ignores unknown keys', () => {
    const merged = mergeSettings({
      'totally.bogus': 42,
    } as unknown as Partial<typeof DEFAULT_SETTINGS>)
    expect(merged).toEqual(DEFAULT_SETTINGS)
    expect('totally.bogus' in merged).toBe(false)
  })

  it('skips undefined values rather than overwriting with undefined', () => {
    const merged = mergeSettings({ 'editor.fontSize': undefined })
    expect(merged['editor.fontSize']).toBe(DEFAULT_SETTINGS['editor.fontSize'])
  })
})

describe('settingsValueEqual', () => {
  it('compares primitives by value', () => {
    expect(settingsValueEqual(13, 13)).toBe(true)
    expect(settingsValueEqual('a', 'b')).toBe(false)
  })

  it('compares string arrays element-wise', () => {
    expect(settingsValueEqual(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(settingsValueEqual(['a'], ['a', 'b'])).toBe(false)
    expect(settingsValueEqual(['a', 'b'], ['b', 'a'])).toBe(false)
  })
})

describe('applyPatch', () => {
  it('records a genuine override', () => {
    const next = applyPatch({}, { 'editor.minimap': true })
    expect(next).toEqual({ 'editor.minimap': true })
  })

  it('drops a key when the patched value equals the default', () => {
    const next = applyPatch(
      { 'editor.minimap': true },
      { 'editor.minimap': DEFAULT_SETTINGS['editor.minimap'] },
    )
    expect('editor.minimap' in next).toBe(false)
  })

  it('preserves existing unrelated overrides', () => {
    const next = applyPatch(
      { 'editor.fontSize': 20 },
      { 'editor.minimap': true },
    )
    expect(next).toEqual({ 'editor.fontSize': 20, 'editor.minimap': true })
  })

  it('ignores unknown keys', () => {
    const next = applyPatch({}, { bogus: 1 } as unknown as Record<
      string,
      never
    >)
    expect(next).toEqual({})
  })

  it('drops a default-valued array override', () => {
    const next = applyPatch(
      { 'search.exclude': ['**/x'] },
      { 'search.exclude': [...DEFAULT_SETTINGS['search.exclude']] },
    )
    expect('search.exclude' in next).toBe(false)
  })
})

describe('sanitizeUser', () => {
  it('keeps only known, non-default keys', () => {
    const clean = sanitizeUser({
      'editor.minimap': true,
      'editor.fontSize': DEFAULT_SETTINGS['editor.fontSize'],
      bogus: 99,
    } as unknown as Record<string, never>)
    expect(clean).toEqual({ 'editor.minimap': true })
  })

  it('returns an empty layer for an all-default object', () => {
    expect(sanitizeUser({ ...DEFAULT_SETTINGS })).toEqual({})
  })
})
