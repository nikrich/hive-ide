/**
 * Merge-conflict parsing tests (E7-06).
 */

import { describe, expect, it } from 'vitest'

import {
  allResolved,
  hasConflicts,
  parseConflicts,
  serialize,
  type ConflictSegment,
} from './mergeConflicts'

const FILE = [
  'line 1',
  '<<<<<<< HEAD',
  'ours a',
  'ours b',
  '=======',
  'theirs a',
  '>>>>>>> branch',
  'line 2',
].join('\n')

const DIFF3 = [
  '<<<<<<< HEAD',
  'ours',
  '||||||| base',
  'orig',
  '=======',
  'theirs',
  '>>>>>>> feature',
].join('\n')

describe('parseConflicts', () => {
  it('detects conflicts', () => {
    expect(hasConflicts(FILE)).toBe(true)
    expect(hasConflicts('no markers here')).toBe(false)
  })

  it('splits text + conflict segments', () => {
    const segs = parseConflicts(FILE)
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ type: 'text', lines: ['line 1'] })
    const c = segs[1] as ConflictSegment
    expect(c.type).toBe('conflict')
    expect(c.current).toEqual(['ours a', 'ours b'])
    expect(c.incoming).toEqual(['theirs a'])
    expect(c.currentLabel).toBe('HEAD')
    expect(c.incomingLabel).toBe('branch')
    expect(segs[2]).toEqual({ type: 'text', lines: ['line 2'] })
  })

  it('captures the base section in diff3 style', () => {
    const c = parseConflicts(DIFF3)[0] as ConflictSegment
    expect(c.base).toEqual(['orig'])
  })
})

describe('serialize + resolution', () => {
  it('defaults to current when unresolved', () => {
    const segs = parseConflicts(FILE)
    expect(serialize(segs)).toBe('line 1\nours a\nours b\nline 2')
  })

  it('honours each resolution choice', () => {
    const segs = parseConflicts(FILE)
    const c = segs[1] as ConflictSegment
    c.resolution = 'incoming'
    expect(serialize(segs)).toBe('line 1\ntheirs a\nline 2')
    c.resolution = 'both'
    expect(serialize(segs)).toBe('line 1\nours a\nours b\ntheirs a\nline 2')
  })

  it('allResolved reflects pending conflicts', () => {
    const segs = parseConflicts(FILE)
    expect(allResolved(segs)).toBe(false)
    ;(segs[1] as ConflictSegment).resolution = 'current'
    expect(allResolved(segs)).toBe(true)
  })
})
