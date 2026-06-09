/**
 * Progress store tests (E11-08).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { newestTask, useProgressStore } from './progressStore'

beforeEach(() => useProgressStore.setState({ tasks: {} }))

describe('progressStore', () => {
  it('starts and ends tasks', () => {
    useProgressStore.getState().start('a', 'Working')
    expect(Object.keys(useProgressStore.getState().tasks)).toEqual(['a'])
    useProgressStore.getState().end('a')
    expect(useProgressStore.getState().tasks).toEqual({})
  })

  it('newestTask returns the most recently started', () => {
    const s = useProgressStore.getState()
    s.start('a', 'First')
    s.start('b', 'Second')
    expect(newestTask(useProgressStore.getState().tasks)?.id).toBe('b')
  })

  it('newestTask is null when idle', () => {
    expect(newestTask({})).toBeNull()
  })
})
