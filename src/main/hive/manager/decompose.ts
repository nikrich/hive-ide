/**
 * Requirement decomposition (slice 2b-2b). Pure prompt builders for the
 * read-only manager run, a defensive parser/validator for its JSON plan, and a
 * writer that fans a validated plan into `proposed` story files. The agent only
 * reads; hive owns every write (validated here).
 */

import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  HIVE_ROLES,
  type HiveRequirement,
  type HiveRole,
  type HiveStory,
  type ManagerPlan,
  type ProposedStory,
  type RepoProfile,
} from '../../../types/hive';
import type { Repo } from '../../../types/workspace';
import { parseRequirement } from '../parse';
import { serializeStory, eventLine } from '../run/serialize';
import { slugify, uniqueStoryId } from '../run/story';
import { serializeRequirement } from './requirement';

/** Thrown when the manager's output is missing/malformed/empty. Caller → blocked. */
export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanParseError';
  }
}

const DEFAULT_ROLE: HiveRole = 'senior';

/** System prompt: a read-only analyst that emits ONLY a fenced JSON plan. */
export function buildDecomposeSystemPrompt(): string {
  return [
    'You are a read-only engineering manager decomposing a requirement into',
    'stories. You MUST NOT edit, write, or modify any file, run commands, or',
    'commit. You only read what you are given and reason.',
    '',
    'Your ENTIRE response must be a single fenced ```json code block — and',
    'nothing else — matching this shape:',
    '{ "stories": [ { "title": string, "body": string, "team": string,',
    '  "role": "manager"|"tech-lead"|"senior"|"intermediate"|"junior"|"qa",',
    '  "acceptanceCriteria": string[] } ] }',
    '',
    'Rules:',
    '- Each story targets exactly ONE repo via its `team` (a repo name from the',
    '  provided profiles).',
    '- Set a sensible `role` and concrete `acceptanceCriteria` per story.',
    '- Emit the stories in execution order (earliest first).',
    '- Do not include prose outside the JSON block.',
  ].join('\n');
}

/** Task prompt: the requirement + every cached repo profile + the contract. */
export function buildDecomposePrompt(
  requirement: HiveRequirement,
  profiles: RepoProfile[],
): string {
  const profileBlocks =
    profiles.length > 0
      ? profiles
          .map((p) => [`### ${p.repo}`, p.body.trim() || '(no profile body)'].join('\n'))
          .join('\n\n')
      : '(no repo profiles available)';
  return [
    `# Requirement ${requirement.id}: ${requirement.title}`,
    '',
    '## Description',
    requirement.body.trim() || '(no description)',
    '',
    '## Available repos (cached profiles)',
    'Route each story to exactly one of these repos by its `team` name:',
    '',
    profileBlocks,
    '',
    '## Output',
    'Respond with ONLY a single fenced ```json block matching:',
    '```json',
    '{ "stories": [ { "title": "...", "body": "...", "team": "<repo>",',
    '  "role": "senior", "acceptanceCriteria": ["..."] } ] }',
    '```',
    'Order the stories by execution order. No prose outside the block.',
  ].join('\n');
}

/** Extract the LAST fenced ```json block, else a bare top-level JSON object. */
function extractJson(text: string): string | null {
  const fence = /```json\s*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fence.exec(text)) !== null) {
    last = match[1].trim();
  }
  if (last !== null) return last;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return null;
}

function coerceRole(v: unknown): HiveRole {
  return typeof v === 'string' && (HIVE_ROLES as readonly string[]).includes(v)
    ? (v as HiveRole)
    : DEFAULT_ROLE;
}

function reqString(v: unknown, field: string, idx: number): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new PlanParseError(`story[${idx}].${field} must be a non-empty string`);
  }
  return v;
}

/**
 * Parse + validate the manager's result text into a ManagerPlan. Throws
 * PlanParseError on anything the caller should treat as a blocked decompose.
 */
export function parsePlan(resultText: string): ManagerPlan {
  const json = extractJson(resultText);
  if (json === null) throw new PlanParseError('no JSON block in manager output');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new PlanParseError(`manager output is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new PlanParseError('manager output is not an object');
  }
  const rawStories = (parsed as { stories?: unknown }).stories;
  if (!Array.isArray(rawStories) || rawStories.length === 0) {
    throw new PlanParseError('manager output has no stories');
  }
  const stories: ProposedStory[] = rawStories.map((raw, idx): ProposedStory => {
    if (!raw || typeof raw !== 'object') {
      throw new PlanParseError(`story[${idx}] is not an object`);
    }
    const s = raw as Record<string, unknown>;
    return {
      title: reqString(s.title, 'title', idx),
      body: reqString(s.body, 'body', idx),
      team: reqString(s.team, 'team', idx),
      role: coerceRole(s.role),
      acceptanceCriteria: Array.isArray(s.acceptanceCriteria)
        ? s.acceptanceCriteria.map((x) => String(x))
        : [],
    };
  });
  return { stories };
}

async function existingStoryIds(workspacePath: string): Promise<Set<string>> {
  try {
    const names = await readdir(join(workspacePath, '.hive', 'state', 'stories'));
    return new Set(names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
  } catch {
    return new Set();
  }
}

/** Build a `proposed` HiveStory from a ProposedStory + a resolved id + ts. */
function buildProposedStory(
  p: ProposedStory,
  id: string,
  reqId: string,
  now: string,
): HiveStory {
  return {
    id,
    title: p.title.trim(),
    status: 'proposed',
    role: p.role,
    points: 0,
    team: p.team,
    dependsOn: [],
    acceptanceCriteria: p.acceptanceCriteria,
    parentRequirement: reqId,
    createdAt: now,
    updatedAt: now,
    body: p.body,
  };
}

export interface WriteProposedResult {
  /** Ids of the written proposed stories, in plan order. */
  storyIds: string[];
  /** Subset of storyIds whose `team` is not a repo name (soft-flagged). */
  unknownTeamIds: string[];
}

/**
 * Fan a validated plan into `proposed` story files, set the requirement to
 * `decomposed` with decomposedInto filled, append a `decomposed` event. Routing
 * is soft: an unknown team is kept (renderer badges it; resolveRepoForStory
 * falls back at run time). Returns the new ids + which had unknown teams.
 */
export async function writeProposedStories(
  workspacePath: string,
  reqId: string,
  plan: ManagerPlan,
  repos: readonly Repo[],
  now: string,
): Promise<WriteProposedResult> {
  const repoNames = new Set(repos.map((r) => r.name));
  const taken = await existingStoryIds(workspacePath);
  const storyIds: string[] = [];
  const unknownTeamIds: string[] = [];

  for (const p of plan.stories) {
    const id = uniqueStoryId(slugify(p.title), taken);
    taken.add(id);
    const story = buildProposedStory(p, id, reqId, now);
    await writeFile(
      join(workspacePath, '.hive', 'state', 'stories', `${id}.md`),
      serializeStory(story),
      'utf8',
    );
    storyIds.push(id);
    if (!repoNames.has(p.team)) unknownTeamIds.push(id);
  }

  const reqPath = join(workspacePath, '.hive', 'state', 'requirements', `${reqId}.md`);
  const current = parseRequirement(await readFile(reqPath, 'utf8'), reqId);
  await writeFile(
    reqPath,
    serializeRequirement({
      ...current,
      status: 'decomposed',
      decomposedInto: storyIds,
      updatedAt: now,
    }),
    'utf8',
  );
  await appendFile(
    join(workspacePath, '.hive', 'events.ndjson'),
    eventLine({ ts: now, actor: 'manager', event: 'decomposed', detail: reqId, level: 'ok' }) + '\n',
    'utf8',
  );

  return { storyIds, unknownTeamIds };
}
