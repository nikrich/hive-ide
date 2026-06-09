import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serializeRequirement, createRequirement } from './requirement';
import { parseRequirement } from '../parse';
import type { HiveRequirement } from '../../../types/hive';

function req(over: Partial<HiveRequirement> = {}): HiveRequirement {
  return {
    id: 'REQ-1', title: 'Add auth', status: 'pending',
    featureBranch: 'feat/auth', decomposedInto: ['S-1', 'S-2'],
    createdAt: '2026-06-09T00:00:00Z', updatedAt: '2026-06-09T01:00:00Z',
    body: 'Build auth.', ...over,
  };
}

describe('serializeRequirement round-trips through parseRequirement', () => {
  it('preserves the written fields', () => {
    const r = req();
    expect(parseRequirement(serializeRequirement(r), r.id)).toEqual(r);
  });

  it('omits absent optionals (round-trips to undefined, not null)', () => {
    const r = req({ featureBranch: undefined, decomposedInto: [] });
    expect(parseRequirement(serializeRequirement(r), r.id)).toEqual(r);
  });
});

describe('createRequirement', () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'hive-req-'));
    await mkdir(join(ws, '.hive', 'state', 'requirements'), { recursive: true });
    await writeFile(join(ws, '.hive', 'events.ndjson'), '', 'utf8');
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it('writes a pending requirement file + a created event, returns the id', async () => {
    const id = await createRequirement(ws, { title: 'Add OAuth login', body: 'Support Google.' }, 't0');
    expect(id).toBe('add-oauth-login');
    const r = parseRequirement(
      await readFile(join(ws, '.hive/state/requirements/add-oauth-login.md'), 'utf8'),
      id,
    );
    expect(r.status).toBe('pending');
    expect(r.title).toBe('Add OAuth login');
    expect(r.body).toBe('Support Google.');
    const events = await readFile(join(ws, '.hive/events.ndjson'), 'utf8');
    expect(events).toContain('"event":"created"');
    expect(events).toContain('"detail":"add-oauth-login"');
  });

  it('de-dupes the id on a slug clash', async () => {
    await createRequirement(ws, { title: 'Add login', body: 'x' }, 't0');
    const id2 = await createRequirement(ws, { title: 'Add login', body: 'y' }, 't1');
    expect(id2).toBe('add-login-2');
  });
});
