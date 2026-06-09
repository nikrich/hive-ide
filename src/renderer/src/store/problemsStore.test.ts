/**
 * Problems store tests (E9-01).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  allDiagnostics,
  countDiagnostics,
  useProblemsStore,
  type Diagnostic,
} from './problemsStore'

const diag = (over: Partial<Diagnostic>): Diagnostic => ({
  file: '/a.ts',
  line: 1,
  column: 1,
  severity: 'error',
  message: 'boom',
  ...over,
})

beforeEach(() => useProblemsStore.setState({ byFile: {} }))

describe('problemsStore', () => {
  it('sets and clears diagnostics for a file', () => {
    const s = useProblemsStore.getState()
    s.setForFile('/a.ts', [diag({})])
    expect(useProblemsStore.getState().byFile['/a.ts']).toHaveLength(1)
    s.setForFile('/a.ts', [])
    expect('/a.ts' in useProblemsStore.getState().byFile).toBe(false)
  })

  it('clearFile / clearAll', () => {
    const s = useProblemsStore.getState()
    s.setForFile('/a.ts', [diag({})])
    s.setForFile('/b.ts', [diag({ file: '/b.ts' })])
    s.clearFile('/a.ts')
    expect('/a.ts' in useProblemsStore.getState().byFile).toBe(false)
    useProblemsStore.getState().clearAll()
    expect(useProblemsStore.getState().byFile).toEqual({})
  })
})

describe('countDiagnostics / allDiagnostics', () => {
  it('tallies by severity', () => {
    const byFile = {
      '/a.ts': [diag({ severity: 'error' }), diag({ severity: 'warning' })],
      '/b.ts': [diag({ severity: 'warning' }), diag({ severity: 'info' })],
    }
    expect(countDiagnostics(byFile)).toEqual({
      errors: 1,
      warnings: 2,
      infos: 1,
      hints: 0,
    })
    expect(allDiagnostics(byFile)).toHaveLength(4)
  })
})
