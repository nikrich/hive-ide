import { describe, expect, it, vi } from 'vitest'

import { reconcileWatchers, type WatcherBridge } from './useProjectWatchers'

/**
 * A fake bridge that hands out sequential ids and records calls. `watch`
 * resolves immediately unless an override is supplied per-path.
 */
function makeBridge(overrides: {
  watch?: (path: string) => Promise<string>
} = {}): WatcherBridge & {
  watched: string[]
  unwatched: string[]
} {
  let n = 0
  const watched: string[] = []
  const unwatched: string[] = []
  return {
    watched,
    unwatched,
    watch:
      overrides.watch ??
      (async (path: string) => {
        watched.push(path)
        n += 1
        return `id-${n}`
      }),
    unwatch: async (id: string) => {
      unwatched.push(id)
    },
  }
}

const always = () => true

describe('reconcileWatchers', () => {
  it('starts one watcher per desired path on a cold map', async () => {
    const active = new Map<string, string>()
    const pending = new Set<string>()
    const bridge = makeBridge()

    await reconcileWatchers(['/a', '/b'], active, pending, bridge, always)

    expect(bridge.watched).toEqual(['/a', '/b'])
    expect([...active.entries()]).toEqual([
      ['/a', 'id-1'],
      ['/b', 'id-2'],
    ])
    expect(bridge.unwatched).toEqual([])
  })

  it('does not restart an already-watched path', async () => {
    const active = new Map<string, string>([['/a', 'id-1']])
    const pending = new Set<string>()
    const bridge = makeBridge()

    await reconcileWatchers(['/a', '/b'], active, pending, bridge, always)

    expect(bridge.watched).toEqual(['/b']) // only the new one
    expect(active.get('/a')).toBe('id-1')
  })

  it('unwatches paths that are no longer desired', async () => {
    const active = new Map<string, string>([
      ['/a', 'id-1'],
      ['/b', 'id-2'],
    ])
    const pending = new Set<string>()
    const bridge = makeBridge()

    await reconcileWatchers(['/a'], active, pending, bridge, always)

    expect(bridge.unwatched).toEqual(['id-2'])
    expect([...active.keys()]).toEqual(['/a'])
  })

  it('cleans up an orphan when the path is removed mid-watch', async () => {
    const active = new Map<string, string>()
    const pending = new Set<string>()
    const bridge = makeBridge()
    // Simulate "/a was removed while watch() was in flight": the
    // still-desired check returns false for it.
    const isStillDesired = (p: string) => p !== '/a'

    await reconcileWatchers(['/a'], active, pending, bridge, isStillDesired)

    expect(bridge.watched).toEqual(['/a'])
    expect(bridge.unwatched).toEqual(['id-1']) // orphan immediately dropped
    expect(active.has('/a')).toBe(false)
    expect(pending.has('/a')).toBe(false)
  })

  it('swallows a watch failure and still processes siblings', async () => {
    const active = new Map<string, string>()
    const pending = new Set<string>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge = makeBridge({
      watch: async (path: string) => {
        if (path === '/bad') throw new Error('boom')
        return `id-${path}`
      },
    })

    await reconcileWatchers(['/bad', '/good'], active, pending, bridge, always)

    expect(active.has('/bad')).toBe(false)
    expect(pending.has('/bad')).toBe(false)
    expect(active.get('/good')).toBe('id-/good')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
