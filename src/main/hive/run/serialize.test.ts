import { describe, it, expect } from 'vitest';

import { serializeStory, serializeAgent, eventLine, nextStoryStatus } from './serialize';
import { parseStory, parseAgent, parseEventLine } from '../parse';
import type { HiveAgent, HiveStory, HiveEvent } from '../../../types/hive';

function story(over: Partial<HiveStory> = {}): HiveStory {
  return {
    id: 'AUTH-3', title: 'Add login form', status: 'in-progress', role: 'senior',
    points: 3, team: 'web', assignedTo: 'run_1', featureBranch: 'feat/AUTH-3',
    dependsOn: ['AUTH-1'], acceptanceCriteria: ['a', 'b'], parentRequirement: 'REQ-1',
    createdAt: '2026-06-05T00:00:00Z', updatedAt: '2026-06-05T01:00:00Z',
    body: 'Implement login.', ...over,
  };
}
function agent(over: Partial<HiveAgent> = {}): HiveAgent {
  return {
    id: 'run_1', role: 'senior', status: 'live', team: 'web', currentStory: 'AUTH-3',
    worktree: '.hive/worktrees/AUTH-3', pid: 4242, startedAt: '2026-06-05T00:00:00Z',
    note: 'working', ...over,
  };
}

describe('serializeStory round-trips through parseStory', () => {
  it('preserves the written fields', () => {
    const s = story();
    expect(parseStory(serializeStory(s), s.id)).toEqual(s);
  });

  it('normalizes body whitespace so serialize/parse is idempotent', () => {
    const s = story({ body: '  Implement login.\n\n' });
    const once = parseStory(serializeStory(s), s.id);
    expect(once.body).toBe('Implement login.');
    expect(parseStory(serializeStory(once), s.id)).toEqual(once);
  });

  it('omits absent optionals (round-trips to undefined, not null)', () => {
    const s = story({
      assignedTo: undefined, featureBranch: undefined, parentRequirement: undefined,
      prUrl: undefined, mergedAt: undefined,
    });
    expect(parseStory(serializeStory(s), s.id)).toEqual(s);
  });
});

describe('serializeAgent round-trips through parseAgent', () => {
  it('preserves the written fields', () => {
    const a = agent();
    expect(parseAgent(serializeAgent(a), a.id)).toEqual(a);
  });
});

describe('eventLine round-trips through parseEventLine', () => {
  it('preserves an event', () => {
    const ev: HiveEvent = {
      ts: '2026-06-05T00:00:00Z', actor: 'run_1', event: 'started',
      detail: 'AUTH-3', level: 'info',
    };
    expect(parseEventLine(eventLine(ev))).toEqual(ev);
  });
});

describe('nextStoryStatus', () => {
  it('success → review', () => expect(nextStoryStatus({ kind: 'success' })).toBe('review'));
  it('no-commit → blocked', () => expect(nextStoryStatus({ kind: 'no-commit' })).toBe('blocked'));
  it('failure → blocked', () => expect(nextStoryStatus({ kind: 'failure' })).toBe('blocked'));
  it('interrupted → pending', () => expect(nextStoryStatus({ kind: 'interrupted' })).toBe('pending'));
  it('needs-input → needs-input', () =>
    expect(nextStoryStatus({ kind: 'needs-input' })).toBe('needs-input'));
});
