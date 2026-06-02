import { describe, expect, it } from 'vitest'

import type { FsChangeEvent } from '../../../preload/api'

import { classifyFsChange, parentOf } from './externalChange'

// ---------------------------------------------------------------------------
// classifyFsChange — the state machine
// ---------------------------------------------------------------------------

const mk = (
  kind: FsChangeEvent['kind'],
  path = '/repo/src/file.ts',
): FsChangeEvent => ({ path, kind })

describe('classifyFsChange — change events', () => {
  it('open + clean + change → silent reload', () => {
    const intent = classifyFsChange(mk('change'), {
      isOpenTab: true,
      isDirty: false,
    })
    expect(intent).toEqual({ kind: 'silent-reload', path: '/repo/src/file.ts' })
  })

  it('open + dirty + change → show banner', () => {
    const intent = classifyFsChange(mk('change'), {
      isOpenTab: true,
      isDirty: true,
    })
    expect(intent).toEqual({ kind: 'show-banner', path: '/repo/src/file.ts' })
  })

  it('not-open + change → refresh parent', () => {
    const intent = classifyFsChange(mk('change', '/repo/src/other.ts'), {
      isOpenTab: false,
      isDirty: false,
    })
    expect(intent).toEqual({
      kind: 'refresh-parent',
      path: '/repo/src/other.ts',
      parent: '/repo/src',
    })
  })
})

describe('classifyFsChange — unlink events', () => {
  it('open + unlink → close-with-toast (regardless of dirty)', () => {
    expect(
      classifyFsChange(mk('unlink'), { isOpenTab: true, isDirty: false }),
    ).toEqual({ kind: 'close-with-toast', path: '/repo/src/file.ts' })

    expect(
      classifyFsChange(mk('unlink'), { isOpenTab: true, isDirty: true }),
    ).toEqual({ kind: 'close-with-toast', path: '/repo/src/file.ts' })
  })

  it('not-open + unlink → refresh parent', () => {
    const intent = classifyFsChange(mk('unlink', '/repo/src/gone.ts'), {
      isOpenTab: false,
      isDirty: false,
    })
    expect(intent).toEqual({
      kind: 'refresh-parent',
      path: '/repo/src/gone.ts',
      parent: '/repo/src',
    })
  })
})

describe('classifyFsChange — tree-level events', () => {
  it('add → refresh parent (path not open)', () => {
    expect(
      classifyFsChange(mk('add', '/repo/src/new.ts'), {
        isOpenTab: false,
        isDirty: false,
      }),
    ).toEqual({
      kind: 'refresh-parent',
      path: '/repo/src/new.ts',
      parent: '/repo/src',
    })
  })

  it('addDir → refresh parent', () => {
    expect(
      classifyFsChange(mk('addDir', '/repo/src/newdir'), {
        isOpenTab: false,
        isDirty: false,
      }),
    ).toEqual({
      kind: 'refresh-parent',
      path: '/repo/src/newdir',
      parent: '/repo/src',
    })
  })

  it('unlinkDir → refresh parent', () => {
    expect(
      classifyFsChange(mk('unlinkDir', '/repo/src/gone'), {
        isOpenTab: false,
        isDirty: false,
      }),
    ).toEqual({
      kind: 'refresh-parent',
      path: '/repo/src/gone',
      parent: '/repo/src',
    })
  })

  it("add for a path that is somehow already open → ignore (defensive)", () => {
    expect(
      classifyFsChange(mk('add'), { isOpenTab: true, isDirty: false }),
    ).toEqual({ kind: 'ignore' })
  })
})

// ---------------------------------------------------------------------------
// parentOf — pure helper, sanity-check the path slicing
// ---------------------------------------------------------------------------

describe('parentOf', () => {
  it('strips the last POSIX segment', () => {
    expect(parentOf('/repo/src/file.ts')).toBe('/repo/src')
  })

  it('strips the last Windows segment', () => {
    expect(parentOf('C:\\repo\\src\\file.ts')).toBe('C:\\repo\\src')
  })

  it('returns the input when there is no parent segment to strip', () => {
    expect(parentOf('/')).toBe('/')
    expect(parentOf('file.ts')).toBe('file.ts')
  })
})
