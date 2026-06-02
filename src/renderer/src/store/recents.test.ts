import { describe, expect, it } from 'vitest'

import type { RecentEntry } from '../../../types/workspace'

import { RECENTS_MAX, pushRecent } from './recents'

const entry = (id: string, lastOpenedAt = 0): RecentEntry => ({
  id,
  name: id,
  rootPath: `/projects/${id}`,
  source: 'auto-detected',
  repoCount: 1,
  lastOpenedAt,
})

describe('recents — pushRecent', () => {
  it('puts the newest entry at the front', () => {
    const next = pushRecent([entry('a'), entry('b')], entry('c'))
    expect(next.map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('dedups by id, moving the new copy to the front', () => {
    const next = pushRecent(
      [entry('a', 1), entry('b', 2), entry('c', 3)],
      entry('b', 99),
    )
    expect(next.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(next[0].lastOpenedAt).toBe(99)
  })

  it(`caps at ${RECENTS_MAX}`, () => {
    let list: RecentEntry[] = []
    // Push 15 unique entries; only the 10 most recent should survive.
    for (let i = 0; i < 15; i++) list = pushRecent(list, entry(`p${i}`))
    expect(list).toHaveLength(RECENTS_MAX)
    // Newest first → `p14` at the head, `p5` at the tail.
    expect(list[0].id).toBe('p14')
    expect(list[list.length - 1].id).toBe('p5')
  })

  it('caps at 10 even when dedup short-circuits a long list', () => {
    let list: RecentEntry[] = []
    for (let i = 0; i < RECENTS_MAX; i++) list = pushRecent(list, entry(`p${i}`))
    // Re-pushing an existing id doesn't grow the list past the cap.
    list = pushRecent(list, entry('p0', 999))
    expect(list).toHaveLength(RECENTS_MAX)
    expect(list[0].id).toBe('p0')
  })

  it('does not mutate the input array', () => {
    const input = [entry('a'), entry('b')]
    const snapshot = [...input]
    pushRecent(input, entry('c'))
    expect(input).toEqual(snapshot)
  })
})
