/**
 * Command registry + context tests (E6-01, E6-05).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCommandStore, visibleCommands } from './commandStore'

beforeEach(() => {
  useCommandStore.setState({ commands: {}, context: {}, recent: [] })
})

describe('commandStore', () => {
  it('registers and executes a command', () => {
    const handler = vi.fn()
    useCommandStore.getState().register({ id: 'a', title: 'A', handler })
    useCommandStore.getState().execute('a', 1, 2)
    expect(handler).toHaveBeenCalledWith(1, 2)
  })

  it('records executed commands in recent, most-recent first, deduped', () => {
    const s = useCommandStore.getState()
    s.register({ id: 'a', title: 'A', handler: () => undefined })
    s.register({ id: 'b', title: 'B', handler: () => undefined })
    s.execute('a')
    s.execute('b')
    s.execute('a')
    expect(useCommandStore.getState().recent).toEqual(['a', 'b'])
  })

  it('unregister via the returned disposer removes the command', () => {
    const dispose = useCommandStore
      .getState()
      .register({ id: 'a', title: 'A', handler: () => undefined })
    dispose()
    expect(useCommandStore.getState().commands.a).toBeUndefined()
  })

  it('warns and no-ops on executing an unknown command', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    useCommandStore.getState().execute('nope')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('setContext / setContextBatch update the context bag', () => {
    useCommandStore.getState().setContext('editorFocus', true)
    expect(useCommandStore.getState().context.editorFocus).toBe(true)
    useCommandStore.getState().setContextBatch({ view: 'ide', hasProject: true })
    expect(useCommandStore.getState().context).toMatchObject({
      editorFocus: true,
      view: 'ide',
      hasProject: true,
    })
  })

  it('visibleCommands filters by when-clause and sorts by category/title', () => {
    const commands = {
      a: { id: 'a', title: 'Zebra', category: 'Editor', handler: () => undefined },
      b: {
        id: 'b',
        title: 'Apple',
        category: 'Editor',
        when: 'editorFocus',
        handler: () => undefined,
      },
      c: { id: 'c', title: 'Mango', category: 'Files', handler: () => undefined },
    }
    const visibleWithFocus = visibleCommands(commands, { editorFocus: true })
    expect(visibleWithFocus.map((c) => c.id)).toEqual(['b', 'a', 'c'])
    const visibleNoFocus = visibleCommands(commands, {})
    expect(visibleNoFocus.map((c) => c.id)).toEqual(['a', 'c'])
  })
})
