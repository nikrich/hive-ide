import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDecomposeSystemPrompt,
  buildDecomposePrompt,
  parsePlan,
  PlanParseError,
  writeProposedStories,
} from './decompose';
import { serializeRequirement } from './requirement';
import { parseStory, parseRequirement } from '../parse';
import type { HiveRequirement, ManagerPlan, RepoProfile } from '../../../types/hive';
import type { Repo } from '../../../types/workspace';

const profiles: RepoProfile[] = [
  { repo: 'bff-web', indexedAt: 't', body: 'Customer web BFF. Stack: TS Lambda.' },
  { repo: 'policy-svc', indexedAt: 't', body: 'Policy microservice. Stack: Java.' },
];
const requirement: HiveRequirement = {
  id: 'REQ-1', title: 'Add a claims endpoint', status: 'decomposing',
  decomposedInto: [], createdAt: 't', updatedAt: 't',
  body: 'Expose POST /v1/claims and persist the claim.',
};

describe('buildDecomposeSystemPrompt', () => {
  it('instructs read-only JSON-only output', () => {
    const sys = buildDecomposeSystemPrompt();
    expect(sys).toMatch(/read-only|do not (edit|write|modify)/i);
    expect(sys).toMatch(/json/i);
  });
});

describe('buildDecomposePrompt', () => {
  it('embeds the requirement + every profile + the ManagerPlan contract', () => {
    const p = buildDecomposePrompt(requirement, profiles);
    expect(p).toContain('Add a claims endpoint');
    expect(p).toContain('Expose POST /v1/claims');
    expect(p).toContain('bff-web');
    expect(p).toContain('policy-svc');
    expect(p).toContain('Customer web BFF');
    expect(p).toContain('"stories"');
    expect(p).toContain('acceptanceCriteria');
  });
});

describe('parsePlan', () => {
  const validBlock = '```json\n' + JSON.stringify({
    stories: [
      { title: 'Add handler', body: 'Create the Lambda.', team: 'bff-web', role: 'senior', acceptanceCriteria: ['returns 201'] },
    ],
  }) + '\n```';

  it('extracts a fenced json block', () => {
    const plan = parsePlan('Here is the plan:\n' + validBlock + '\nDone.');
    expect(plan.stories).toHaveLength(1);
    expect(plan.stories[0].team).toBe('bff-web');
  });

  it('takes the LAST fenced json block when several appear', () => {
    const first = '```json\n' + JSON.stringify({ stories: [{ title: 'A', body: 'a', team: 'x', role: 'junior', acceptanceCriteria: [] }] }) + '\n```';
    const plan = parsePlan(first + '\n' + validBlock);
    expect(plan.stories[0].title).toBe('Add handler');
  });

  it('accepts a bare top-level JSON object with no fence', () => {
    const plan = parsePlan(JSON.stringify({ stories: [{ title: 'T', body: 'b', team: 'bff-web', role: 'senior', acceptanceCriteria: ['x'] }] }));
    expect(plan.stories).toHaveLength(1);
  });

  it('coerces an unknown role to senior', () => {
    const plan = parsePlan('```json\n' + JSON.stringify({ stories: [{ title: 'T', body: 'b', team: 'bff-web', role: 'wizard', acceptanceCriteria: ['x'] }] }) + '\n```');
    expect(plan.stories[0].role).toBe('senior');
  });

  it('defaults a missing acceptanceCriteria to []', () => {
    const plan = parsePlan('```json\n' + JSON.stringify({ stories: [{ title: 'T', body: 'b', team: 'bff-web', role: 'senior' }] }) + '\n```');
    expect(plan.stories[0].acceptanceCriteria).toEqual([]);
  });

  it('throws PlanParseError when there is no JSON', () => {
    expect(() => parsePlan('no json here')).toThrow(PlanParseError);
  });

  it('throws PlanParseError on empty stories', () => {
    expect(() => parsePlan('```json\n{"stories":[]}\n```')).toThrow(PlanParseError);
  });

  it('throws PlanParseError when a story is missing a required string field', () => {
    expect(() => parsePlan('```json\n' + JSON.stringify({ stories: [{ title: 'T', team: 'bff-web', role: 'senior', acceptanceCriteria: [] }] }) + '\n```')).toThrow(PlanParseError);
  });

  it('throws PlanParseError on malformed JSON in the fence', () => {
    expect(() => parsePlan('```json\n{ not json\n```')).toThrow(PlanParseError);
  });
});

describe('writeProposedStories', () => {
  let ws: string;
  const repos: Repo[] = [
    { name: 'bff-web', path: '/r/bff-web', isGitRepo: true },
    { name: 'policy-svc', path: '/r/policy-svc', isGitRepo: true },
  ];
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'hive-dec-'));
    await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
    await mkdir(join(ws, '.hive', 'state', 'requirements'), { recursive: true });
    await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
    await writeFile(
      join(ws, '.hive/state/requirements/REQ-1.md'),
      serializeRequirement(requirement),
      'utf8',
    );
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it('writes proposed stories, sets the requirement decomposed + decomposed event', async () => {
    const plan: ManagerPlan = {
      stories: [
        { title: 'Add handler', body: 'Create the Lambda.', team: 'bff-web', role: 'senior', acceptanceCriteria: ['returns 201'] },
        { title: 'Persist claim', body: 'Store it.', team: 'policy-svc', role: 'intermediate', acceptanceCriteria: ['row inserted'] },
      ],
    };
    const res = await writeProposedStories(ws, 'REQ-1', plan, repos, 't1');
    expect(res.storyIds).toHaveLength(2);
    expect(res.unknownTeamIds).toEqual([]);

    const s0 = parseStory(await readFile(join(ws, '.hive/state/stories', `${res.storyIds[0]}.md`), 'utf8'), res.storyIds[0]);
    expect(s0.status).toBe('proposed');
    expect(s0.parentRequirement).toBe('REQ-1');
    expect(s0.team).toBe('bff-web');
    expect(s0.role).toBe('senior');

    const r = parseRequirement(await readFile(join(ws, '.hive/state/requirements/REQ-1.md'), 'utf8'), 'REQ-1');
    expect(r.status).toBe('decomposed');
    expect(r.decomposedInto).toEqual(res.storyIds);

    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"decomposed"');
    expect(events).toContain('"detail":"REQ-1"');
  });

  it('still writes a story routed to an unknown team and flags it', async () => {
    const plan: ManagerPlan = {
      stories: [
        { title: 'Mystery', body: 'x', team: 'nope', role: 'senior', acceptanceCriteria: [] },
      ],
    };
    const res = await writeProposedStories(ws, 'REQ-1', plan, repos, 't1');
    expect(res.storyIds).toHaveLength(1);
    expect(res.unknownTeamIds).toEqual(res.storyIds);
    const s = parseStory(await readFile(join(ws, '.hive/state/stories', `${res.storyIds[0]}.md`), 'utf8'), res.storyIds[0]);
    expect(s.team).toBe('nope'); // kept as-is; renderer badges it
  });
});
