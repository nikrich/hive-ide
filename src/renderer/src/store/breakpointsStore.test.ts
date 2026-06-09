/**
 * Breakpoints store tests (E3-03, E3-10).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  breakpointLines,
  totalBreakpoints,
  useBreakpointsStore,
} from './breakpointsStore'

beforeEach(() => useBreakpointsStore.setState({ byFile: {} }))

describe('breakpointsStore', () => {
  it('toggles a breakpoint on and off, keeping lines sorted', () => {
    const s = useBreakpointsStore.getState()
    s.toggle('/a.ts', 10)
    s.toggle('/a.ts', 3)
    expect(breakpointLines(useBreakpointsStore.getState().byFile['/a.ts'])).toEqual([
      3, 10,
    ])
    s.toggle('/a.ts', 3)
    expect(breakpointLines(useBreakpointsStore.getState().byFile['/a.ts'])).toEqual([
      10,
    ])
  })

  it('drops the file entry when the last breakpoint is removed', () => {
    const s = useBreakpointsStore.getState()
    s.toggle('/a.ts', 1)
    s.toggle('/a.ts', 1)
    expect('/a.ts' in useBreakpointsStore.getState().byFile).toBe(false)
  })

  it('setBreakpoint adds/updates a conditional breakpoint (E3-10)', () => {
    const s = useBreakpointsStore.getState()
    s.toggle('/a.ts', 5)
    s.setBreakpoint('/a.ts', { line: 5, condition: 'x > 1' })
    const bp = useBreakpointsStore.getState().byFile['/a.ts'][0]
    expect(bp).toEqual({ line: 5, condition: 'x > 1' })
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
    expect(
      totalBreakpoints({ '/a.ts': [{ line: 1 }, { line: 2 }], '/b.ts': [{ line: 3 }] }),
    ).toBe(3)
  })
})
