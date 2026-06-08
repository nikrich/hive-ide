/**
 * Status bar registry tests (E11-01).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { sortedSide, useStatusBarStore } from './statusBarStore'

beforeEach(() => {
  useStatusBarStore.setState({ items: {} })
})

describe('statusBarStore', () => {
  it('registers an item and disposes it', () => {
    const dispose = useStatusBarStore.getState().register({
      id: 'a',
      alignment: 'left',
      priority: 1,
      text: 'A',
    })
    expect(useStatusBarStore.getState().items.a).toBeDefined()
    dispose()
    expect(useStatusBarStore.getState().items.a).toBeUndefined()
  })

  it('update patches an existing item', () => {
    const s = useStatusBarStore.getState()
    s.register({ id: 'a', alignment: 'left', priority: 1, text: 'A' })
    s.update('a', { text: 'B' })
    expect(useStatusBarStore.getState().items.a.text).toBe('B')
  })

  it('sortedSide orders higher priority toward the outer edge, per side', () => {
    const s = useStatusBarStore.getState()
    s.register({ id: 'l1', alignment: 'left', priority: 10, text: '' })
    s.register({ id: 'l2', alignment: 'left', priority: 90, text: '' })
    s.register({ id: 'r1', alignment: 'right', priority: 5, text: '' })
    const items = useStatusBarStore.getState().items
    expect(sortedSide(items, 'left').map((i) => i.id)).toEqual(['l2', 'l1'])
    expect(sortedSide(items, 'right').map((i) => i.id)).toEqual(['r1'])
  })
})
