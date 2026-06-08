/**
 * Breakpoints store tests (E3-03).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { totalBreakpoints, useBreakpointsStore } from './breakpointsStore'

beforeEach(() => useBreakpointsStore.setState({ byFile: {} }))

describe('breakpointsStore', () => {
  it('toggles a breakpoint on and off, keeping lines sorted', () => {
    const s = useBreakpointsStore.getState()
    s.toggle('/a.ts', 10)
    s.toggle('/a.ts', 3)
    expect(useBreakpointsStore.getState().byFile['/a.ts']).toEqual([3, 10])
    s.toggle('/a.ts', 3)
    expect(useBreakpointsStore.getState().byFile['/a.ts']).toEqual([10])
  })

  it('drops the file entry when the last breakpoint is removed', () => {
    const s = useBreakpointsStore.getState()
    s.toggle('/a.ts', 1)
    s.toggle('/a.ts', 1)
    expect('/a.ts' in useBreakpointsStore.getState().byFile).toBe(false)
  })

  it('clearFile / clearAll', () => {
    const s = useBreakpointsStore.getState()
    s.toggle('/a.ts', 1)
    s.toggle('/b.ts', 2)
    s.clearFile('/a.ts')
    expect('/a.ts' in useBreakpointsStore.getState().byFile).toBe(false)
    useBreakpointsStore.getState().clearAll()
    expect(useBreakpointsStore.getState().byFile).toEqual({})
  })

  it('totalBreakpoints counts across files', () => {
    expect(totalBreakpoints({ '/a.ts': [1, 2], '/b.ts': [3] })).toBe(3)
  })
})
