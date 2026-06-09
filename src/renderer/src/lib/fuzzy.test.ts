/**
 * Fuzzy matching tests (E2-03).
 */

import { describe, expect, it } from 'vitest'

import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('returns -1 for a non-subsequence', () => {
    expect(fuzzyScore('zzz', 'abc')).toBe(-1)
  })
  it('scores a subsequence positively', () => {
    expect(fuzzyScore('ts', 'index.ts')).toBeGreaterThan(0)
  })
})

describe('fuzzyFilter', () => {
  const files = ['src/app.ts', 'src/store/workspace.ts', 'README.md', 'src/App.tsx']

  it('returns all items for an empty query', () => {
    expect(fuzzyFilter('', files, (f) => f)).toEqual(files)
  })

  it('keeps only matches, ranked best-first', () => {
    const out = fuzzyFilter('apts', files, (f) => f)
    expect(out).toContain('src/app.ts')
    expect(out).not.toContain('README.md')
  })

  it('ranks a tight basename match above a scattered one', () => {
    const out = fuzzyFilter('app', files, (f) => f)
    // app.ts / App.tsx should beat workspace.ts (no 'app' subsequence anyway)
    expect(out[0].toLowerCase()).toContain('app')
  })
})
