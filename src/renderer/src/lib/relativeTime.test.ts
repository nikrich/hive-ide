import { describe, expect, it } from 'vitest'

import { formatRelativeTime } from './relativeTime'

// Use a fixed reference instant so the tests are deterministic.
const NOW = new Date('2026-01-15T12:00:00Z').getTime()
const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

describe('formatRelativeTime', () => {
  it('returns "just now" for deltas under a minute', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now')
    expect(formatRelativeTime(NOW - 30 * SECOND, NOW)).toBe('just now')
  })

  it('returns "just now" for future timestamps (clock skew)', () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).toBe('just now')
  })

  it('uses singular minute when n === 1', () => {
    expect(formatRelativeTime(NOW - MINUTE, NOW)).toBe('1 minute ago')
  })

  it('pluralises minutes when n > 1', () => {
    expect(formatRelativeTime(NOW - 5 * MINUTE, NOW)).toBe('5 minutes ago')
    expect(formatRelativeTime(NOW - 59 * MINUTE, NOW)).toBe('59 minutes ago')
  })

  it('formats hours', () => {
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe('1 hour ago')
    expect(formatRelativeTime(NOW - 3 * HOUR, NOW)).toBe('3 hours ago')
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe('23 hours ago')
  })

  it('uses "yesterday" for deltas between 24h and 48h', () => {
    expect(formatRelativeTime(NOW - DAY, NOW)).toBe('yesterday')
    expect(formatRelativeTime(NOW - 47 * HOUR, NOW)).toBe('yesterday')
  })

  it('formats days from 48h up to a week', () => {
    expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toBe('2 days ago')
    expect(formatRelativeTime(NOW - 6 * DAY, NOW)).toBe('6 days ago')
  })

  it('formats weeks from one week up to roughly a month', () => {
    expect(formatRelativeTime(NOW - WEEK, NOW)).toBe('1 week ago')
    expect(formatRelativeTime(NOW - 3 * WEEK, NOW)).toBe('3 weeks ago')
  })

  it('formats months past ~30 days', () => {
    expect(formatRelativeTime(NOW - 60 * DAY, NOW)).toBe('2 months ago')
    expect(formatRelativeTime(NOW - 300 * DAY, NOW)).toBe('10 months ago')
  })

  it('formats years past 365 days', () => {
    expect(formatRelativeTime(NOW - 400 * DAY, NOW)).toBe('1 year ago')
    expect(formatRelativeTime(NOW - 800 * DAY, NOW)).toBe('2 years ago')
  })
})
