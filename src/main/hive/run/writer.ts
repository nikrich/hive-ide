/**
 * Apply a worker run's start/finish to the slice-1 file store (slice 2a).
 * Reads the current story, mutates it + the agent record, appends events.
 * Best-effort: callers wrap in try/catch; a failed write must not crash main.
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HiveAgent, HiveEvent, HiveStory } from '../../../types/hive';
import { parseStory, parseAgent } from '../parse';
import { serializeStory, serializeAgent, eventLine, nextStoryStatus } from './serialize';

function storyPath(ws: string, id: string): string {
  return join(ws, '.hive', 'state', 'stories', `${id}.md`);
}
function agentPath(ws: string, id: string): string {
  return join(ws, '.hive', 'state', 'agents', `${id}.md`);
}
function eventsPath(ws: string): string {
  return join(ws, '.hive', 'events.ndjson');
}

async function appendEvent(ws: string, ev: HiveEvent): Promise<void> {
  await appendFile(eventsPath(ws), eventLine(ev) + '\n', 'utf8');
}

export async function writeRunStart(opts: {
  workspacePath: string;
  story: HiveStory;
  runId: string;
  featureBranch: string;
  worktree: string;
  pid: number | undefined;
  now: string;
}): Promise<void> {
  const { workspacePath: ws, story, runId, featureBranch, worktree, pid, now } = opts;
  const updated: HiveStory = {
    ...story,
    status: 'in-progress',
    assignedTo: runId,
    featureBranch,
    updatedAt: now,
  };
  await writeFile(storyPath(ws, story.id), serializeStory(updated), 'utf8');

  const agent: HiveAgent = {
    id: runId,
    role: story.role,
    status: 'live',
    team: story.team,
    currentStory: story.id,
    worktree,
    pid,
    startedAt: now,
    note: `running ${story.id}`,
  };
  await writeFile(agentPath(ws, runId), serializeAgent(agent), 'utf8');

  await appendEvent(ws, {
    ts: now, actor: runId, event: 'started', detail: story.id, level: 'info',
  });
}

export async function writeRunFinish(opts: {
  workspacePath: string;
  storyId: string;
  runId: string;
  outcome: { kind: 'success' } | { kind: 'no-commit' } | { kind: 'failure' } | { kind: 'interrupted' };
  now: string;
}): Promise<void> {
  const { workspacePath: ws, storyId, runId, outcome, now } = opts;

  // Re-read the story so we don't clobber any field changed meanwhile.
  const current = parseStory(await readFile(storyPath(ws, storyId), 'utf8'), storyId);
  const updated: HiveStory = {
    ...current,
    status: nextStoryStatus(outcome),
    updatedAt: now,
  };
  await writeFile(storyPath(ws, storyId), serializeStory(updated), 'utf8');

  const note =
    outcome.kind === 'success' ? 'completed'
    : outcome.kind === 'no-commit' ? 'no changes produced'
    : outcome.kind === 'interrupted' ? 'stopped'
    : 'failed';
  const prevAgent = parseAgent(await readFile(agentPath(ws, runId), 'utf8'), runId);
  const agent: HiveAgent = { ...prevAgent, status: 'exited', endedAt: now, note };
  await writeFile(agentPath(ws, runId), serializeAgent(agent), 'utf8');

  const level: HiveEvent['level'] = outcome.kind === 'success' ? 'ok' : 'warn';
  const event = outcome.kind === 'success' ? 'finished' : 'failed';
  await appendEvent(ws, { ts: now, actor: runId, event, detail: `${storyId} (${note})`, level });
}
