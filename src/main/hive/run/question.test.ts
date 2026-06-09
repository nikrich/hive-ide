import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readQuestion, answerQuestion } from './question';
import { serializeStory } from './serialize';
import { parseStory } from '../parse';
import type { HiveStory } from '../../../types/hive';

let ws: string;
const story: HiveStory = {
  id: 'AUTH-3', title: 'Add login', status: 'needs-input', role: 'senior', points: 0,
  team: '', dependsOn: [], acceptanceCriteria: ['a'], createdAt: 't', updatedAt: 't',
  body: 'Implement login.',
};

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'hive-q-'));
  await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
  await mkdir(join(ws, '.hive', 'state', 'questions'), { recursive: true });
  await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
  await writeFile(join(ws, '.hive', 'state', 'stories', 'AUTH-3.md'), serializeStory(story));
});
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe('readQuestion', () => {
  it('returns the question text when present', async () => {
    await writeFile(join(ws, '.hive/state/questions/AUTH-3.md'), 'Which DB?\n', 'utf8');
    expect(await readQuestion(ws, 'AUTH-3')).toBe('Which DB?');
  });
  it('returns null when absent', async () => {
    expect(await readQuestion(ws, 'AUTH-3')).toBeNull();
  });
});

describe('answerQuestion', () => {
  it('appends a Q&A block to the body, deletes the file, sets pending, logs answered', async () => {
    await writeFile(join(ws, '.hive/state/questions/AUTH-3.md'), 'Which DB?', 'utf8');
    await answerQuestion(ws, 'AUTH-3', 'Use Postgres.', 't2');

    const s = parseStory(await readFile(join(ws, '.hive/state/stories/AUTH-3.md'), 'utf8'), 'AUTH-3');
    expect(s.status).toBe('pending');
    expect(s.body).toContain('Which DB?');
    expect(s.body).toContain('Use Postgres.');

    await expect(access(join(ws, '.hive/state/questions/AUTH-3.md'))).rejects.toThrow();

    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"answered"');
  });
});
