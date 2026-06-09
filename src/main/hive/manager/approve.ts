/**
 * Requirement approval gate (slice 2b-2b). approvePlan flips the requirement's
 * `proposed` stories to `pending` (the 2b-1 loop then runs them) and the
 * requirement to `in-flight`. discardPlan deletes the proposed stories + the
 * requirement file so a rejected plan leaves no trace for the loop.
 */

import { appendFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HiveStory } from '../../../types/hive';
import { parseStory, parseRequirement } from '../parse';
import { serializeStory, eventLine } from '../run/serialize';
import { serializeRequirement } from './requirement';

function storiesDir(ws: string): string {
  return join(ws, '.hive', 'state', 'stories');
}
function reqPath(ws: string, reqId: string): string {
  return join(ws, '.hive', 'state', 'requirements', `${reqId}.md`);
}

/** The `proposed` stories under a requirement (parentRequirement === reqId). */
async function proposedStoriesFor(ws: string, reqId: string): Promise<HiveStory[]> {
  let names: string[];
  try {
    names = await readdir(storiesDir(ws));
  } catch {
    return [];
  }
  const out: HiveStory[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    try {
      const s = parseStory(await readFile(join(storiesDir(ws), name), 'utf8'), id);
      if (s.status === 'proposed' && s.parentRequirement === reqId) out.push(s);
    } catch {
      // skip unparseable
    }
  }
  return out;
}

/** Approve: proposed stories → pending, requirement → in-flight, log approved. */
export async function approvePlan(ws: string, reqId: string, now: string): Promise<void> {
  const stories = await proposedStoriesFor(ws, reqId);
  for (const s of stories) {
    await writeFile(
      join(storiesDir(ws), `${s.id}.md`),
      serializeStory({ ...s, status: 'pending', updatedAt: now }),
      'utf8',
    );
  }
  try {
    const current = parseRequirement(await readFile(reqPath(ws, reqId), 'utf8'), reqId);
    await writeFile(
      reqPath(ws, reqId),
      serializeRequirement({ ...current, status: 'in-flight', updatedAt: now }),
      'utf8',
    );
  } catch {
    // requirement file missing — still log the approval for the stories
  }
  await appendFile(
    join(ws, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'user', event: 'approved', detail: reqId, level: 'ok' }) + '\n',
    'utf8',
  );
}

/** Discard: delete the requirement's proposed stories + the requirement, log abandoned. */
export async function discardPlan(ws: string, reqId: string, now: string): Promise<void> {
  const stories = await proposedStoriesFor(ws, reqId);
  for (const s of stories) {
    await rm(join(storiesDir(ws), `${s.id}.md`), { force: true });
  }
  await rm(reqPath(ws, reqId), { force: true });
  await appendFile(
    join(ws, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'user', event: 'abandoned', detail: reqId, level: 'warn' }) + '\n',
    'utf8',
  );
}
