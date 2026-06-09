import { describe, expect, it } from 'vitest'

import { toBoard, toChatMsgs, toLogLines, toNeedsInput, toPrCards, toRequirementCards, toRoster } from './hiveView'
import type { HiveAgent, HiveEvent, HiveRequirement, HiveStory } from '../../../types/hive'

const story = (over: Partial<HiveStory>): HiveStory => ({
  id: 'S',
  title: 'S',
  status: 'pending',
  role: 'junior',
  points: 1,
  team: 'api',
  dependsOn: [],
  acceptanceCriteria: [],
  createdAt: '',
  updatedAt: '',
  body: '',
  ...over,
})

describe('toBoard', () => {
  it('buckets statuses into pending/running/review/done', () => {
    const board = toBoard([
      story({ id: 'a', status: 'pending' }),
      story({ id: 'b', status: 'assigned' }),
      story({ id: 'c', status: 'in-progress' }),
      story({ id: 'd', status: 'review' }),
      story({ id: 'e', status: 'merged' }),
      story({ id: 'f', status: 'blocked' }),
      story({ id: 'g', status: 'abandoned' }),
    ])
    expect(board.pending.map((s) => s.id)).toEqual(['a', 'b', 'f', 'g'])
    expect(board.running.map((s) => s.id)).toEqual(['c'])
    expect(board.review.map((s) => s.id)).toEqual(['d'])
    expect(board.done.map((s) => s.id)).toEqual(['e'])
  })

  it('maps tech-lead role to the techlead seed key', () => {
    const board = toBoard([story({ id: 'a', role: 'tech-lead' })])
    expect(board.pending[0].role).toBe('techlead')
  })

  it('excludes needs-input stories from the pending column', () => {
    const board = toBoard([story({ id: 'a', status: 'needs-input' })])
    expect(board.pending.find((s) => s.id === 'a')).toBeUndefined()
  })

  it('excludes proposed stories from all board columns (approval gate)', () => {
    const board = toBoard([story({ id: 'p', status: 'proposed' })])
    const allCards = [...board.pending, ...board.running, ...board.review, ...board.done]
    expect(allCards.find((s) => s.id === 'p')).toBeUndefined()
  })
})

describe('toNeedsInput', () => {
  it('returns only needs-input stories', () => {
    const out = toNeedsInput([
      story({ id: 'A', status: 'needs-input' }),
      story({ id: 'B', status: 'pending' }),
    ])
    expect(out.map((s) => s.id)).toEqual(['A'])
  })
})

describe('toRoster', () => {
  it('maps agents to roster rows (live→running, exited→done)', () => {
    const agents: HiveAgent[] = [
      { id: 'a1', role: 'senior', status: 'live', team: 'api', startedAt: '', note: 'reviewing' },
      { id: 'a2', role: 'qa', status: 'exited', team: 'api', startedAt: '' },
    ]
    const roster = toRoster(agents)
    expect(roster[0]).toMatchObject({ role: 'senior', status: 'running', note: 'reviewing' })
    expect(roster[1]).toMatchObject({ role: 'qa', status: 'done' })
  })

  it('falls back to currentStory when note is absent', () => {
    const roster = toRoster([
      { id: 'a', role: 'junior', status: 'live', team: 'api', startedAt: '', currentStory: 'S-3' },
    ])
    expect(roster[0].note).toContain('S-3')
  })
})

describe('toLogLines', () => {
  it('maps events to LogLine, level→cls and ts→HH:MM', () => {
    const events: HiveEvent[] = [
      { ts: '2026-06-03T09:05:00Z', actor: 'manager', event: 'spawned', detail: 'S-7', level: 'ok' },
      { ts: 'bad', actor: 'mgr', event: 'tick', detail: '', level: 'warn' },
    ]
    const lines = toLogLines(events)
    expect(lines[0]).toMatchObject({ cls: 'ok' })
    expect(lines[0].txt).toContain('spawned')
    expect(lines[1].cls).toBe('dim') // warn → dim
    expect(lines[1].t).toBe('--:--') // unparseable ts
  })
})

const req = (over: Partial<HiveRequirement>): HiveRequirement => ({
  id: 'REQ-1', title: 'Req', status: 'decomposed', decomposedInto: [],
  createdAt: '', updatedAt: '', body: '', ...over,
})

describe('toRequirementCards', () => {
  it('groups proposed stories under their parent requirement, tagging routed repos', () => {
    const cards = toRequirementCards(
      [req({ id: 'REQ-1', status: 'decomposed' })],
      [
        story({ id: 's1', status: 'proposed', parentRequirement: 'REQ-1', team: 'bff-web', role: 'senior' }),
        story({ id: 's2', status: 'proposed', parentRequirement: 'REQ-1', team: 'nope', role: 'junior' }),
        story({ id: 's3', status: 'pending', parentRequirement: 'REQ-1', team: 'bff-web' }),
      ],
      ['bff-web', 'policy-svc'],
    )
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe('REQ-1')
    expect(cards[0].status).toBe('decomposed')
    expect(cards[0].proposed.map((p) => p.id)).toEqual(['s1', 's2']) // pending excluded
    expect(cards[0].proposed[0]).toMatchObject({ team: 'bff-web', unknownRepo: false })
    expect(cards[0].proposed[1]).toMatchObject({ team: 'nope', unknownRepo: true })
  })

  it('shows a decomposing requirement with no proposed stories yet', () => {
    const cards = toRequirementCards([req({ id: 'R', status: 'decomposing' })], [], ['bff-web'])
    expect(cards[0].status).toBe('decomposing')
    expect(cards[0].proposed).toEqual([])
  })

  it('omits pending requirements (nothing to review yet)', () => {
    const cards = toRequirementCards([req({ id: 'R', status: 'pending' })], [], [])
    expect(cards).toEqual([])
  })
})

describe('toPrCards', () => {
  it('derives cards from stories with a prUrl, newest first', () => {
    const cards = toPrCards(
      [
        story({ id: 'S1', title: 'A', status: 'review', role: 'senior', prUrl: 'https://github.com/o/r/pull/12', featureBranch: 'feat/a', updatedAt: '2026-06-09T10:00:00Z' }),
        story({ id: 'S2', title: 'B', status: 'merged', role: 'tech-lead', prUrl: 'https://github.com/o/r/pull/15', featureBranch: 'feat/b', updatedAt: '2026-06-09T11:00:00Z', mergedAt: '2026-06-09T11:00:00Z' }),
        story({ id: 'S3', title: 'C', status: 'in-progress', role: 'junior', updatedAt: '2026-06-09T09:00:00Z' }),
      ],
      new Date('2026-06-09T12:00:00Z'),
    )
    expect(cards.map((c) => c.num)).toEqual([15, 12])
    expect(cards[0]).toEqual({
      storyId: 'S2', num: 15, title: 'B', role: 'techlead',
      branch: 'feat/b', status: 'merged', url: 'https://github.com/o/r/pull/15',
      time: '1h ago',
    })
    expect(cards[1].status).toBe('review')
  })

  it('handles unparsable PR numbers and missing branches', () => {
    const [card] = toPrCards(
      [story({ id: 'S4', title: 'D', status: 'review', role: 'qa', prUrl: 'https://example.com/x', updatedAt: '2026-06-09T11:59:30Z' })],
      new Date('2026-06-09T12:00:00Z'),
    )
    expect(card.num).toBeNull()
    expect(card.branch).toBe('')
    expect(card.time).toBe('just now')
  })
})

describe('toChatMsgs', () => {
  it('maps operator and role messages to panel ChatMsg shape', () => {
    expect(
      toChatMsgs([
        { ts: 't1', who: 'you', txt: 'hello' },
        { ts: 't2', who: 'tech-lead', txt: 'on it' },
      ]),
    ).toEqual([
      { who: 'you', txt: 'hello' },
      { who: 'techlead', role: 'techlead', txt: 'on it' },
    ])
  })
})
