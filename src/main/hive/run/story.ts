/**
 * Story authoring (slice 2c): turn New-story form fields into a slice-1 story
 * file + a `created` event. Pure helpers (slugify / uniqueStoryId / buildStory)
 * plus a thin writer (createStory) that reads existing ids to de-dupe.
 */

import { appendFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HiveStory, NewStoryFields } from '../../../types/hive';
import { serializeStory, eventLine } from './serialize';

/** Title → filename-stem slug. Empty/symbol-only → 'story'. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'story' : slug;
}

/** Unique id from a base slug given the existing ids (append -2/-3 on clash). */
export function uniqueStoryId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Build a pending HiveStory from form fields + a resolved id + timestamp. */
export function buildStory(fields: NewStoryFields, id: string, now: string): HiveStory {
  return {
    id,
    title: fields.title.trim(),
    status: 'pending',
    role: fields.role,
    points: 0,
    team: fields.team,
    dependsOn: [],
    acceptanceCriteria: fields.acceptanceCriteria,
    createdAt: now,
    updatedAt: now,
    body: fields.body,
  };
}

/** Existing story ids (filename stems) under <ws>/.hive/state/stories/. */
async function existingStoryIds(workspacePath: string): Promise<Set<string>> {
  try {
    const names = await readdir(join(workspacePath, '.hive', 'state', 'stories'));
    return new Set(names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
  } catch {
    return new Set();
  }
}

/**
 * Write a new story file (de-duped id) + append a `created` event. Returns the
 * new story id. Throws on fs failure — the IPC handler surfaces it.
 */
export async function createStory(
  workspacePath: string,
  fields: NewStoryFields,
  now: string,
): Promise<string> {
  const existing = await existingStoryIds(workspacePath);
  const id = uniqueStoryId(slugify(fields.title), existing);
  const story = buildStory(fields, id, now);

  await writeFile(
    join(workspacePath, '.hive', 'state', 'stories', `${id}.md`),
    serializeStory(story),
    'utf8',
  );
  await appendFile(
    join(workspacePath, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'user', event: 'created', detail: id, level: 'info' }) + '\n',
    'utf8',
  );
  return id;
}
