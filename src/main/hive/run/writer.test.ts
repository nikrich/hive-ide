import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeRunStart, writeRunFinish } from './writer';
import { serializeStory } from './serialize';
import { parseStory, parseAgent } from '../parse';
import type { HiveStory } from '../../../types/hive';

let ws: string;
const story: HiveStory = {
  id: 'AUTH-3', title: 'Add login', status: 'pending', role: 'senior', points: 3,
  team: 'web', dependsOn: [], acceptanceCriteria: ['a'], createdAt: 't', updatedAt: 't',
  body: 'do it',
};

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'hivews-'));
  await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
  await mkdir(join(ws, '.hive', 'state', 'agents'), { recursive: true });
  await writeFile(join(ws, '.hive', 'state', 'stories', 'AUTH-3.md'), serializeStory(story));
});
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe('writeRunStart', () => {
  it('sets the story in-progress, writes the agent live, appends a started event', async () => {
    await writeRunStart({
      workspacePath: ws, story, runId: 'run_1', featureBranch: 'feat/AUTH-3',
      worktree: '.hive/worktrees/AUTH-3', pid: 4242, now: '2026-06-05T00:00:00Z',
    });
    const s = parseStory(await readFile(join(ws, '.hive/state/stories/AUTH-3.md'), 'utf8'), 'AUTH-3');
    expect(s.status).toBe('in-progress');
    expect(s.assignedTo).toBe('run_1');
    expect(s.featureBranch).toBe('feat/AUTH-3');
    const a = parseAgent(await readFile(join(ws, '.hive/state/agents/run_1.md'), 'utf8'), 'run_1');
    expect(a.status).toBe('live');
    expect(a.currentStory).toBe('AUTH-3');
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"started"');
  });
});

describe('writeRunFinish', () => {
  it('success → story review, agent exited, finished event', async () => {
    await writeRunStart({
      workspacePath: ws, story, runId: 'run_1', featureBranch: 'feat/AUTH-3',
      worktree: '.hive/worktrees/AUTH-3', pid: 4242, now: 't0',
    });
    await writeRunFinish({
      workspacePath: ws, storyId: 'AUTH-3', runId: 'run_1',
      outcome: { kind: 'success' }, now: '2026-06-05T01:00:00Z',
    });
    const s = parseStory(await readFile(join(ws, '.hive/state/stories/AUTH-3.md'), 'utf8'), 'AUTH-3');
    expect(s.status).toBe('review');
    const a = parseAgent(await readFile(join(ws, '.hive/state/agents/run_1.md'), 'utf8'), 'run_1');
    expect(a.status).toBe('exited');
    expect(a.startedAt).toBe('t0');   // from writeRunStart, not the finish time
    expect(a.worktree).toBe('.hive/worktrees/AUTH-3');
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"finished"');
  });

  it('no-commit → blocked, failed event', async () => {
    await writeRunStart({
      workspacePath: ws, story, runId: 'run_2', featureBranch: 'feat/AUTH-3',
      worktree: '.hive/worktrees/AUTH-3', pid: 1, now: 't0',
    });
    await writeRunFinish({
      workspacePath: ws, storyId: 'AUTH-3', runId: 'run_2',
      outcome: { kind: 'no-commit' }, now: 't1',
    });
    const s = parseStory(await readFile(join(ws, '.hive/state/stories/AUTH-3.md'), 'utf8'), 'AUTH-3');
    expect(s.status).toBe('blocked');
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"failed"');
  });
});
