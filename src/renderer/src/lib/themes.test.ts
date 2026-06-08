/**
 * Theme resolution tests (E8).
 */

import { describe, expect, it } from 'vitest'

import { resolveThemeId, THEME_CHOICES } from './themes'

describe('resolveThemeId', () => {
  it('returns the explicit theme regardless of OS preference', () => {
    expect(resolveThemeId('hive-dark', false)).toBe('hive-dark')
    expect(resolveThemeId('hive-light', true)).toBe('hive-light')
  })

  it('follows the OS preference for "system"', () => {
    expect(resolveThemeId('system', true)).toBe('hive-dark')
    expect(resolveThemeId('system', false)).toBe('hive-light')
  })
})

describe('THEME_CHOICES', () => {
  it('offers dark, light, and system', () => {
    expect(THEME_CHOICES.map((c) => c.id)).toEqual([
      'hive-dark',
      'hive-light',
      'system',
    ])
  })
})
