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

// `git diff` output for a brand-new (added) file.
const NEW_FILE_DIFF = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+const a = 1',
  '+const b = 2',
].join('\n')

// `git diff` output for a deleted file.
const DELETED_FILE_DIFF = [
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-const a = 1',
  '-const b = 2',
].join('\n')

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

  it('emits a new-file patch when the old side is empty (-0,0)', () => {
    const hunk = parseHunks(NEW_FILE_DIFF)[0]
    const patch = buildHunkPatch('src/new.ts', hunk)
    expect(patch).toContain('diff --git a/src/new.ts b/src/new.ts')
    expect(patch).toContain('new file mode 100644')
    expect(patch).toContain('--- /dev/null')
    expect(patch).toContain('+++ b/src/new.ts')
    expect(patch).not.toContain('--- a/src/new.ts')
  })

  it('emits a deleted-file patch when the new side is empty (+0,0)', () => {
    const hunk = parseHunks(DELETED_FILE_DIFF)[0]
    const patch = buildHunkPatch('src/old.ts', hunk)
    expect(patch).toContain('diff --git a/src/old.ts b/src/old.ts')
    expect(patch).toContain('deleted file mode 100644')
    expect(patch).toContain('--- a/src/old.ts')
    expect(patch).toContain('+++ /dev/null')
    expect(patch).not.toContain('+++ b/src/old.ts')
  })

  it('leaves normal hunks free of mode / dev-null headers', () => {
    const hunk = parseHunks(DIFF)[0]
    const patch = buildHunkPatch('src/x.ts', hunk)
    expect(patch).not.toContain('new file mode')
    expect(patch).not.toContain('deleted file mode')
    expect(patch).not.toContain('/dev/null')
  })
})
