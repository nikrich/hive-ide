/**
 * Serialize hive entities back to the slice-1 on-disk format (pure) — slice 2a.
 *
 * Emits the same snake_case frontmatter keys `parse.ts` reads, so
 * `parse(serialize(x))` round-trips. Optional fields are omitted when absent
 * (parse treats absent === undefined).
 */

import { stringify } from 'yaml';

import type { HiveAgent, HiveEvent, HiveStory, StoryStatus } from '../../../types/hive';

function frontmatter(data: Record<string, unknown>, body: string): string {
  // Drop undefined so absent optionals aren't written as `key: null`.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringify(clean).trimEnd();
  // Write the body in the form parse() produces (it trims), so serialize is
  // idempotent against parse and repeated write/read cycles don't drift.
  const trimmedBody = body.trim();
  return `---\n${yaml}\n---\n${trimmedBody ? trimmedBody + '\n' : ''}`;
}

export function serializeStory(s: HiveStory): string {
  return frontmatter(
    {
      status: s.status,
      title: s.title,
      role: s.role,
      points: s.points,
      team: s.team,
      assigned_to: s.assignedTo,
      feature_branch: s.featureBranch,
      depends_on: s.dependsOn,
      acceptance_criteria: s.acceptanceCriteria,
      parent_requirement: s.parentRequirement,
      pr_url: s.prUrl,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      merged_at: s.mergedAt,
    },
    s.body,
  );
}

export function serializeAgent(a: HiveAgent): string {
  // Agents carry no markdown body in slice 1 (parseAgent ignores it).
  return frontmatter(
    {
      status: a.status,
      role: a.role,
      team: a.team,
      current_story: a.currentStory,
      worktree: a.worktree,
      pid: a.pid,
      started_at: a.startedAt,
      ended_at: a.endedAt,
      note: a.note,
    },
    '',
  );
}

/** One `events.ndjson` line. */
export function eventLine(ev: HiveEvent): string {
  return JSON.stringify({
    ts: ev.ts,
    actor: ev.actor,
    event: ev.event,
    detail: ev.detail,
    level: ev.level,
  });
}

/** Story status after a finished run. */
export function nextStoryStatus(
  outcome:
    | { kind: 'success' }
    | { kind: 'no-commit' }
    | { kind: 'failure' }
    | { kind: 'interrupted' },
): StoryStatus {
  switch (outcome.kind) {
    case 'success':
      return 'review';
    case 'no-commit':
    case 'failure':
      return 'blocked';
    case 'interrupted':
      return 'pending';
  }
}
