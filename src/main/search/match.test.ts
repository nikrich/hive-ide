/**
 * Search primitive tests (E2-01).
 */

import { describe, expect, it } from 'vitest'

import {
  buildMatcher,
  fuzzyScore,
  globToRegExp,
  looksBinary,
  matchesAnyGlob,
} from './match'

describe('buildMatcher', () => {
  it('matches a literal substring case-insensitively by default', () => {
    const m = buildMatcher('foo')
    expect(m('a Foo and foo')).toEqual([
      { start: 2, end: 5 },
      { start: 10, end: 13 },
    ])
  })

  it('honours case sensitivity', () => {
    const m = buildMatcher('Foo', { caseSensitive: true })
    expect(m('Foo foo')).toEqual([{ start: 0, end: 3 }])
  })

  it('escapes regex metachars in literal mode', () => {
    const m = buildMatcher('a.b')
    expect(m('axb a.b')).toEqual([{ start: 4, end: 7 }])
  })

  it('supports regex mode', () => {
    const m = buildMatcher('f.o', { regex: true })
    expect(m('foo fxo')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ])
  })

  it('supports whole-word matching', () => {
    const m = buildMatcher('cat', { wholeWord: true })
    expect(m('cat category cat')).toEqual([
      { start: 0, end: 3 },
      { start: 13, end: 16 },
    ])
  })

  it('returns no matches for an empty query', () => {
    expect(buildMatcher('')('anything')).toEqual([])
  })

  it('does not loop forever on a zero-width regex', () => {
    const m = buildMatcher('x*', { regex: true })
    expect(() => m('abc')).not.toThrow()
  })
})

describe('globToRegExp / matchesAnyGlob', () => {
  it('matches ** across segments', () => {
    expect(matchesAnyGlob('a/b/node_modules/c', ['**/node_modules'])).toBe(true)
    expect(matchesAnyGlob('node_modules', ['**/node_modules'])).toBe(true)
  })

  it('matches * within a segment only', () => {
    expect(globToRegExp('*.log').test('a/foo.log')).toBe(true)
    expect(globToRegExp('*.log').test('a/foo.txt')).toBe(false)
  })

  it('returns false when nothing matches', () => {
    expect(matchesAnyGlob('src/index.ts', ['**/node_modules', '**/dist'])).toBe(
      false,
    )
  })
})

describe('looksBinary', () => {
  it('detects a NUL byte', () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
  })
  it('treats text as non-binary', () => {
    expect(looksBinary(Buffer.from('hello world', 'utf8'))).toBe(false)
  })
})

describe('fuzzyScore', () => {
  it('returns -1 when not a subsequence', () => {
    expect(fuzzyScore('xyz', 'abc')).toBe(-1)
  })
  it('scores a subsequence positively', () => {
    expect(fuzzyScore('abc', 'aXbXc')).toBeGreaterThan(0)
  })
  it('ranks consecutive / boundary matches higher', () => {
    const consecutive = fuzzyScore('app', 'app.ts')
    const scattered = fuzzyScore('app', 'a_p_p_long_name.ts')
    expect(consecutive).toBeGreaterThan(scattered)
  })
})
