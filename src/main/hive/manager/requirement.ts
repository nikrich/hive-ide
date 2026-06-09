/**
 * Requirement authoring (slice 2b-2b): turn New-requirement form fields into a
 * slice-1 requirement file + a `created` event, and serialize a HiveRequirement
 * back to the on-disk format. Mirrors run/story.ts (slugify + unique id + write)
 * and run/serialize.ts (snake_case frontmatter that round-trips through parse).
 */

import { appendFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';

import type { HiveRequirement, NewRequirementFields } from '../../../types/hive';
import { eventLine } from '../run/serialize';
import { slugify, uniqueStoryId } from '../run/story';

/** Serialize a requirement to the slice-1 frontmatter `parseRequirement` reads. */
export function serializeRequirement(r: HiveRequirement): string {
  const data: Record<string, unknown> = {
    status: r.status,
    title: r.title,
    feature_branch: r.featureBranch,
    decomposed_into: r.decomposedInto,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringify(clean).trimEnd();
  const body = r.body.trim();
  return `---\n${yaml}\n---\n${body ? body + '\n' : ''}`;
}

/** Existing requirement ids (filename stems) under <ws>/.hive/state/requirements/. */
async function existingRequirementIds(workspacePath: string): Promise<Set<string>> {
  try {
    const names = await readdir(join(workspacePath, '.hive', 'state', 'requirements'));
    return new Set(names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
  } catch {
    return new Set();
  }
}

/**
 * Write a new `pending` requirement file (de-duped id) + append a `created`
 * event. Returns the new requirement id. Throws on fs failure (the handler
 * surfaces it).
 */
export async function createRequirement(
  workspacePath: string,
  fields: NewRequirementFields,
  now: string,
): Promise<string> {
  const existing = await existingRequirementIds(workspacePath);
  const id = uniqueStoryId(slugify(fields.title), existing);
  const requirement: HiveRequirement = {
    id,
    title: fields.title.trim(),
    status: 'pending',
    decomposedInto: [],
    createdAt: now,
    updatedAt: now,
    body: fields.body,
  };

  await writeFile(
    join(workspacePath, '.hive', 'state', 'requirements', `${id}.md`),
    serializeRequirement(requirement),
    'utf8',
  );
  await appendFile(
    join(workspacePath, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'user', event: 'created', detail: id, level: 'info' }) + '\n',
    'utf8',
  );
  return id;
}
