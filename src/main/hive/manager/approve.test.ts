import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { approvePlan, discardPlan } from './approve';
import { serializeStory } from '../run/serialize';
import { serializeRequirement } from './requirement';
import { parseStory, parseRequirement } from '../parse';
import type { HiveRequirement, HiveStory } from '../../../types/hive';

let ws: string;

function story(over: Partial<HiveStory>): HiveStory {
  return {
    id: 'x', title: 'x', status: 'proposed', role: 'senior', points: 0,
    team: 'web', dependsOn: [], acceptanceCriteria: ['a'], parentRequirement: 'REQ-1',
    createdAt: 't', updatedAt: 't', body: 'b', ...over,
  };
}
const requirement: HiveRequirement = {
  id: 'REQ-1', title: 'Req', status: 'decomposed',
  decomposedInto: ['s-a', 's-b'], createdAt: 't', updatedAt: 't', body: 'desc',
};

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'hive-appr-'));
  await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
  await mkdir(join(ws, '.hive', 'state', 'requirements'), { recursive: true });
  await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
  await writeFile(join(ws, '.hive/state/requirements/REQ-1.md'), serializeRequirement(requirement));
  await writeFile(join(ws, '.hive/state/stories/s-a.md'), serializeStory(story({ id: 's-a' })));
  await writeFile(join(ws, '.hive/state/stories/s-b.md'), serializeStory(story({ id: 's-b' })));
  // An unrelated story must be left untouched.
  await writeFile(join(ws, '.hive/state/stories/other.md'), serializeStory(story({ id: 'other', parentRequirement: 'REQ-9' })));
});
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe('approvePlan', () => {
  it('flips the requirement proposed stories to pending, requirement to in-flight, logs approved', async () => {
    await approvePlan(ws, 'REQ-1', 't2');
    const a = parseStory(await readFile(join(ws, '.hive/state/stories/s-a.md'), 'utf8'), 's-a');
    const b = parseStory(await readFile(join(ws, '.hive/state/stories/s-b.md'), 'utf8'), 's-b');
    expect(a.status).toBe('pending');
    expect(b.status).toBe('pending');
    const r = parseRequirement(await readFile(join(ws, '.hive/state/requirements/REQ-1.md'), 'utf8'), 'REQ-1');
    expect(r.status).toBe('in-flight');
    const other = parseStory(await readFile(join(ws, '.hive/state/stories/other.md'), 'utf8'), 'other');
    expect(other.status).toBe('proposed'); // untouched
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"approved"');
  });
});

describe('discardPlan', () => {
  it('deletes the proposed stories + the requirement, logs abandoned, leaves others', async () => {
    await discardPlan(ws, 'REQ-1', 't2');
    await expect(access(join(ws, '.hive/state/stories/s-a.md'))).rejects.toThrow();
    await expect(access(join(ws, '.hive/state/stories/s-b.md'))).rejects.toThrow();
    await expect(access(join(ws, '.hive/state/requirements/REQ-1.md'))).rejects.toThrow();
    await access(join(ws, '.hive/state/stories/other.md')); // survives
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"abandoned"');
  });
});
