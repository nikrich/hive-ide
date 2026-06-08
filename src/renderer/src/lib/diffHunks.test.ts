/**
 * Diff-hunk parsing tests (E7-04, E7-02).
 */

import { describe, expect, it } from 'vitest'

import { buildHunkPatch, computeLineChanges, parseHunks } from './diffHunks'

const DIFF = [
  'diff --git a/src/x.ts b/src/x.ts',
  'index 111..222 100644',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1,4 +1,5 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 20',
  '+const c = 3',
  ' const d = 4',
  '@@ -10,2 +11,1 @@',
  ' keep',
  '-gone',
].join('\n')

describe('parseHunks', () => {
  it('parses hunk headers + bodies', () => {
    const hunks = parseHunks(DIFF)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 })
    expect(hunks[1]).toMatchObject({ oldStart: 10, newStart: 11 })
  })
})

describe('computeLineChanges', () => {
  it('classifies modified, added, and deletions', () => {
    const c = computeLineChanges(DIFF)
    // line 2 (new) replaced old → modified; line 3 is a pure addition.
    expect(c.modified).toContain(2)
    expect(c.added).toContain(3)
    // second hunk removed a line with no addition → a deletion caret.
    expect(c.deleted.length).toBeGreaterThan(0)
  })

  it('returns empty arrays for an empty diff', () => {
    expect(computeLineChanges('')).toEqual({ added: [], modified: [], deleted: [] })
  })
})

describe('buildHunkPatch', () => {
  it('wraps a hunk in apply-able headers', () => {
    const hunk = parseHunks(DIFF)[0]
    const patch = buildHunkPatch('src/x.ts', hunk)
    expect(patch).toContain('diff --git a/src/x.ts b/src/x.ts')
    expect(patch).toContain('--- a/src/x.ts')
    expect(patch).toContain('+++ b/src/x.ts')
    expect(patch).toContain('@@ -1,4 +1,5 @@')
    expect(patch.endsWith('\n')).toBe(true)
  })
})
