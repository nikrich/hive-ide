import { afterEach, describe, expect, it, vi } from 'vitest'
import mock from 'mock-fs'

import {
  parseAgent,
  parseEventLine,
  parseRequirement,
  parseStory,
  readSnapshot,
  splitFrontmatter,
} from './parse'

afterEach(() => mock.restore())

describe('splitFrontmatter', () => {
  it('splits frontmatter from body', () => {
    const raw = '---\ntitle: Hello\nstatus: pending\n---\nthe body\nmore'
    const { data, body } = splitFrontmatter(raw)
    expect(data).toEqual({ title: 'Hello', status: 'pending' })
    expect(body).toBe('the body\nmore')
  })

  it('returns empty data + whole input as body when no frontmatter', () => {
    const { data, body } = splitFrontmatter('just text')
    expect(data).toEqual({})
    expect(body).toBe('just text')
  })
})

describe('parseStory', () => {
  it('parses a full story', () => {
    const raw = [
      '---',
      'title: Rate-limit the token endpoint',
      'status: review',
      'role: senior',
      'points: 3',
      'team: api',
      'assigned_to: a1b2',
      'feature_branch: feature/rate-limit',
      'depends_on: [STORY-1, STORY-2]',
      'acceptance_criteria:',
      '  - returns 429 over limit',
      'parent_requirement: REQ-9',
      'pr_url: https://x/pr/1',
      'created_at: 2026-06-03T00:00:00Z',
      'updated_at: 2026-06-03T01:00:00Z',
      '---',
      'Limit the endpoint.',
    ].join('\n')
    const s = parseStory(raw, 'STORY-7')
    expect(s).toEqual({
      id: 'STORY-7',
      title: 'Rate-limit the token endpoint',
      status: 'review',
      role: 'senior',
      points: 3,
      team: 'api',
      assignedTo: 'a1b2',
      featureBranch: 'feature/rate-limit',
      dependsOn: ['STORY-1', 'STORY-2'],
      acceptanceCriteria: ['returns 429 over limit'],
      parentRequirement: 'REQ-9',
      prUrl: 'https://x/pr/1',
      createdAt: '2026-06-03T00:00:00Z',
      updatedAt: '2026-06-03T01:00:00Z',
      mergedAt: undefined,
      body: 'Limit the endpoint.',
    })
  })

  it('coerces an unknown status to pending and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = parseStory('---\ntitle: X\nstatus: wat\nrole: junior\n---\n', 'S1')
    expect(s.status).toBe('pending')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('falls back to the id for a missing title, with empty defaults', () => {
    const s = parseStory('---\nstatus: pending\n---\n', 'S2')
    expect(s.title).toBe('S2')
    expect(s.points).toBe(0)
    expect(s.dependsOn).toEqual([])
    expect(s.acceptanceCriteria).toEqual([])
    expect(s.role).toBe('junior') // role fallback
  })
})

describe('parseAgent', () => {
  it('parses an agent and coerces unknown status to exited', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = [
      '---',
      'role: tech-lead',
      'status: wat',
      'team: api',
      'current_story: STORY-7',
      'worktree: repos/api--tech-lead-a1b2',
      'pid: 4242',
      'started_at: 2026-06-03T00:00:00Z',
      'note: decomposing',
      '---',
    ].join('\n')
    const a = parseAgent(raw, 'a1b2')
    expect(a).toEqual({
      id: 'a1b2',
      role: 'tech-lead',
      status: 'exited',
      team: 'api',
      currentStory: 'STORY-7',
      worktree: 'repos/api--tech-lead-a1b2',
      pid: 4242,
      startedAt: '2026-06-03T00:00:00Z',
      endedAt: undefined,
      note: 'decomposing',
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('parseRequirement', () => {
  it('parses a requirement', () => {
    const raw = [
      '---',
      'title: Add auth',
      'status: decomposed',
      'feature_branch: feature/auth',
      'decomposed_into: [STORY-1, STORY-2]',
      'created_at: 2026-06-03T00:00:00Z',
      'updated_at: 2026-06-03T01:00:00Z',
      '---',
      'Build auth.',
    ].join('\n')
    const r = parseRequirement(raw, 'REQ-1')
    expect(r.id).toBe('REQ-1')
    expect(r.status).toBe('decomposed')
    expect(r.decomposedInto).toEqual(['STORY-1', 'STORY-2'])
    expect(r.body).toBe('Build auth.')
  })
})

describe('parseEventLine', () => {
  it('parses a valid ndjson line', () => {
    const line = JSON.stringify({
      ts: '2026-06-03T00:00:00Z',
      actor: 'manager',
      event: 'spawned',
      detail: 'STORY-7',
      level: 'ok',
    })
    expect(parseEventLine(line)).toEqual({
      ts: '2026-06-03T00:00:00Z',
      actor: 'manager',
      event: 'spawned',
      detail: 'STORY-7',
      level: 'ok',
    })
  })

  it('returns null for blank or invalid JSON', () => {
    expect(parseEventLine('')).toBeNull()
    expect(parseEventLine('   ')).toBeNull()
    expect(parseEventLine('{not json')).toBeNull()
  })

  it('defaults an unknown level to info', () => {
    const line = JSON.stringify({ ts: 't', actor: 'a', event: 'e', detail: 'd', level: 'zzz' })
    expect(parseEventLine(line)?.level).toBe('info')
  })
})

describe('readSnapshot', () => {
  it('aggregates stories, agents, requirements; skips a malformed file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mock({
      '/ws/.hive/state/stories/STORY-1.md':
        '---\ntitle: One\nstatus: pending\nrole: junior\n---\n',
      '/ws/.hive/state/stories/STORY-2.md':
        '---\ntitle: Two\nstatus: review\nrole: senior\n---\n',
      '/ws/.hive/state/agents/a1.md':
        '---\nrole: senior\nstatus: live\nteam: api\nstarted_at: t\n---\n',
      '/ws/.hive/state/requirements/REQ-1.md':
        '---\ntitle: Req\nstatus: pending\n---\n',
      '/ws/.hive/state/stories/notes.txt': 'ignore me',
    })
    const snap = await readSnapshot('/ws/.hive/state')
    expect(snap.stories.map((s) => s.id).sort()).toEqual(['STORY-1', 'STORY-2'])
    expect(snap.agents.map((a) => a.id)).toEqual(['a1'])
    expect(snap.requirements.map((r) => r.id)).toEqual(['REQ-1'])
    warn.mockRestore()
  })

  it('returns empty arrays when state dirs are missing', async () => {
    mock({ '/ws/.hive': {} })
    const snap = await readSnapshot('/ws/.hive/state')
    expect(snap).toEqual({ requirements: [], stories: [], agents: [] })
  })
})
