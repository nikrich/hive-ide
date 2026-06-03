import { describe, expect, it } from 'vitest'

import { toBoard, toLogLines, toRoster } from './hiveView'
import type { HiveAgent, HiveEvent, HiveStory } from '../../../types/hive'

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
