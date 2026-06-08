/**
 * Theme resolution tests (E8).
 */

import { describe, expect, it } from 'vitest'

import { parseTokenRules, resolveThemeId, THEME_CHOICES } from './themes'

describe('resolveThemeId', () => {
  it('returns the explicit theme regardless of OS preference', () => {
    expect(resolveThemeId('hive-dark', false)).toBe('hive-dark')
    expect(resolveThemeId('hive-light', true)).toBe('hive-light')
  })

  it('follows the OS preference for "system"', () => {
    expect(resolveThemeId('system', true)).toBe('hive-dark')
    expect(resolveThemeId('system', false)).toBe('hive-light')
  })

  it('resolves the high-contrast theme', () => {
    expect(resolveThemeId('hive-hc', true)).toBe('hive-hc')
  })
})

describe('parseTokenRules', () => {
  it('parses scope=rrggbb lines, dropping invalid ones', () => {
    expect(
      parseTokenRules(['comment=6a9955', 'keyword=#569cd6', 'bad', 'x=zzz']),
    ).toEqual([
      { token: 'comment', foreground: '6a9955' },
      { token: 'keyword', foreground: '569cd6' },
    ])
  })
})

describe('THEME_CHOICES', () => {
  it('offers dark, light, high-contrast, and system', () => {
    expect(THEME_CHOICES.map((c) => c.id)).toEqual([
      'hive-dark',
      'hive-light',
      'hive-hc',
      'system',
    ])
  })
})
