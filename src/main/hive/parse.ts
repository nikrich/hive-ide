/**
 * Pure parsing for the `.hive/state/**` files + `events.ndjson`.
 *
 * Kept free of IPC and chokidar so it is unit-testable (mock-fs for the
 * directory reads). The reader (./reader.ts) wires these into a watcher.
 *
 * Robustness rule (spec §Error handling): one bad file/line must never blank
 * the view — unparseable files are skipped, unknown enum values are coerced
 * to a typed fallback, and both warn.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  HIVE_ROLES,
  STORY_STATUSES,
  type HiveAgent,
  type HiveChatMessage,
  type HiveEvent,
  type HiveEventLevel,
  type HiveRequirement,
  type HiveRole,
  type HiveSnapshot,
  type HiveStory,
  type RequirementStatus,
  type StoryStatus,
} from '../../types/hive';

const REQ_STATUSES: readonly RequirementStatus[] = [
  'pending',
  'decomposing',
  'decomposed',
  'in-flight',
  'complete',
  'blocked',
];
const EVENT_LEVELS: readonly HiveEventLevel[] = ['info', 'ok', 'warn', 'pr'];

/** Split a `---`-delimited YAML frontmatter block from the markdown body. */
export function splitFrontmatter(raw: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const text = raw.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { data, body: (match[2] ?? '').trim() };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
function role(v: unknown, where: string): HiveRole {
  if (typeof v === 'string' && (HIVE_ROLES as readonly string[]).includes(v)) {
    return v as HiveRole;
  }
  if (v !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(`hive parse: unknown role "${String(v)}" in ${where}, using junior`);
  }
  return 'junior';
}

export function parseStory(raw: string, id: string): HiveStory {
  const { data, body } = splitFrontmatter(raw);
  let status = data.status as unknown;
  if (typeof status !== 'string' || !(STORY_STATUSES as readonly string[]).includes(status)) {
    if (status !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(`hive parse: unknown story status "${String(status)}" in ${id}, using pending`);
    }
    status = 'pending';
  }
  return {
    id,
    title: str(data.title) ?? id,
    status: status as StoryStatus,
    role: role(data.role, id),
    points: num(data.points),
    team: str(data.team) ?? '',
    assignedTo: str(data.assigned_to),
    featureBranch: str(data.feature_branch),
    dependsOn: list(data.depends_on),
    acceptanceCriteria: list(data.acceptance_criteria),
    parentRequirement: str(data.parent_requirement),
    prUrl: str(data.pr_url),
    createdAt: str(data.created_at) ?? '',
    updatedAt: str(data.updated_at) ?? '',
    mergedAt: str(data.merged_at),
    body,
  };
}

export function parseAgent(raw: string, id: string): HiveAgent {
  const { data } = splitFrontmatter(raw);
  let status = data.status as unknown;
  if (status !== 'live' && status !== 'exited') {
    if (status !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(`hive parse: unknown agent status "${String(status)}" in ${id}, using exited`);
    }
    status = 'exited';
  }
  return {
    id,
    role: role(data.role, id),
    status: status as HiveAgent['status'],
    team: str(data.team) ?? '',
    currentStory: str(data.current_story),
    worktree: str(data.worktree),
    pid: typeof data.pid === 'number' ? data.pid : undefined,
    startedAt: str(data.started_at) ?? '',
    endedAt: str(data.ended_at),
    note: str(data.note),
  };
}

export function parseRequirement(raw: string, id: string): HiveRequirement {
  const { data, body } = splitFrontmatter(raw);
  let status = data.status as unknown;
  if (typeof status !== 'string' || !(REQ_STATUSES as readonly string[]).includes(status)) {
    if (status !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(`hive parse: unknown requirement status "${String(status)}" in ${id}, using pending`);
    }
    status = 'pending';
  }
  return {
    id,
    title: str(data.title) ?? id,
    status: status as RequirementStatus,
    featureBranch: str(data.feature_branch),
    decomposedInto: list(data.decomposed_into),
    createdAt: str(data.created_at) ?? '',
    updatedAt: str(data.updated_at) ?? '',
    body,
  };
}

export function parseEventLine(line: string): HiveEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const level =
    typeof obj.level === 'string' && (EVENT_LEVELS as readonly string[]).includes(obj.level)
      ? (obj.level as HiveEventLevel)
      : 'info';
  return {
    ts: str(obj.ts) ?? '',
    actor: str(obj.actor) ?? '',
    event: str(obj.event) ?? '',
    detail: str(obj.detail) ?? '',
    level,
  };
}

/** Parse one `chat.ndjson` line. Returns null for blank/malformed lines. */
export function parseChatLine(line: string): HiveChatMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.txt !== 'string' || obj.txt === '') return null;
  const who =
    obj.who === 'you' ||
    (typeof obj.who === 'string' && (HIVE_ROLES as readonly string[]).includes(obj.who))
      ? (obj.who as HiveChatMessage['who'])
      : 'manager';
  return {
    ts: str(obj.ts) ?? '',
    who,
    txt: obj.txt,
  };
}

/** Read + parse every `<stateDir>/<kind>/*.md`, aggregate into a snapshot. */
export async function readSnapshot(stateDir: string): Promise<HiveSnapshot> {
  const [requirements, stories, agents] = await Promise.all([
    readKind(join(stateDir, 'requirements'), parseRequirement),
    readKind(join(stateDir, 'stories'), parseStory),
    readKind(join(stateDir, 'agents'), parseAgent),
  ]);
  return { requirements, stories, agents };
}

async function readKind<T>(
  dir: string,
  parseOne: (raw: string, id: string) => T,
): Promise<T[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // dir missing → empty
  }
  const out: T[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    try {
      const raw = await fs.readFile(join(dir, name), 'utf8');
      out.push(parseOne(raw, id));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`hive parse: failed to read ${join(dir, name)}`, e);
    }
  }
  return out;
}
