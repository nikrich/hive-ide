import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { slugify, uniqueStoryId, buildStory, createStory } from './story';
import { parseStory } from '../parse';
import type { NewStoryFields } from '../../../types/hive';

const fields: NewStoryFields = {
  title: 'Add login form',
  body: 'Implement the login form.',
  role: 'senior',
  team: 'web',
  acceptanceCriteria: ['Validates email', 'Submits to /login'],
};

describe('slugify', () => {
  it('lowercases, trims, replaces non-alphanumerics with single dashes', () => {
    expect(slugify('Add login form')).toBe('add-login-form');
    expect(slugify('  Fix: the THING!! ')).toBe('fix-the-thing');
    expect(slugify('a/b\\c')).toBe('a-b-c');
  });
  it('falls back to "story" for an empty/symbol-only title', () => {
    expect(slugify('')).toBe('story');
    expect(slugify('!!!')).toBe('story');
  });
});

describe('uniqueStoryId', () => {
  it('returns the base when free', () => {
    expect(uniqueStoryId('add-login', new Set())).toBe('add-login');
  });
  it('appends -2, -3 on collision', () => {
    expect(uniqueStoryId('add-login', new Set(['add-login']))).toBe('add-login-2');
    expect(uniqueStoryId('add-login', new Set(['add-login', 'add-login-2']))).toBe('add-login-3');
  });
});

describe('buildStory', () => {
  it('builds a pending story', () => {
    const s = buildStory(fields, 'add-login-form', '2026-06-08T00:00:00Z');
    expect(s.status).toBe('pending');
    expect(s.team).toBe('web');
    expect(s.role).toBe('senior');
    expect(s.acceptanceCriteria).toEqual(['Validates email', 'Submits to /login']);
    expect(s.createdAt).toBe('2026-06-08T00:00:00Z');
    expect(s.updatedAt).toBe('2026-06-08T00:00:00Z');
    expect(s.id).toBe('add-login-form');
  });
});

describe('createStory', () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'hive-ws-'));
    await mkdir(join(ws, '.hive', 'state', 'stories'), { recursive: true });
    await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it('writes stories/<id>.md, appends a created event, returns the id', async () => {
    const id = await createStory(ws, fields, '2026-06-08T00:00:00Z');
    expect(id).toBe('add-login-form');
    const raw = await readFile(join(ws, '.hive', 'state', 'stories', 'add-login-form.md'), 'utf8');
    const parsed = parseStory(raw, id);
    expect(parsed.title).toBe('Add login form');
    expect(parsed.status).toBe('pending');
    expect(parsed.team).toBe('web');
    const events = await readFile(join(ws, '.hive', 'events.ndjson'), 'utf8');
    expect(events).toContain('"event":"created"');
  });

  it('de-dupes the id when a same-titled story exists', async () => {
    await createStory(ws, fields, 't0');
    const id2 = await createStory(ws, fields, 't1');
    expect(id2).toBe('add-login-form-2');
    const names = await readdir(join(ws, '.hive', 'state', 'stories'));
    expect(names).toContain('add-login-form.md');
    expect(names).toContain('add-login-form-2.md');
  });
});
