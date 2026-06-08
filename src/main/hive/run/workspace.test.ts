import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { workspaceDirFor, ensureWorkspace } from './workspace';

let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'hive-ud-'));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('workspaceDirFor', () => {
  it('joins userData/hive-workspaces/<projectId>', () => {
    expect(workspaceDirFor('/ud', 'p1')).toBe('/ud/hive-workspaces/p1');
  });
});

describe('ensureWorkspace', () => {
  it('creates the .hive state tree + empty events.ndjson and returns the dir', async () => {
    const dir = await ensureWorkspace(userData, 'p1');
    expect(dir).toBe(join(userData, 'hive-workspaces', 'p1'));
    for (const sub of ['requirements', 'stories', 'agents']) {
      const s = await stat(join(dir, '.hive', 'state', sub));
      expect(s.isDirectory()).toBe(true);
    }
    expect(await readFile(join(dir, '.hive', 'events.ndjson'), 'utf8')).toBe('');
  });

  it('is idempotent and does not truncate an existing events.ndjson', async () => {
    const dir = await ensureWorkspace(userData, 'p1');
    await writeFile(join(dir, '.hive', 'events.ndjson'), '{"x":1}\n', 'utf8');
    const again = await ensureWorkspace(userData, 'p1');
    expect(again).toBe(dir);
    expect(await readFile(join(dir, '.hive', 'events.ndjson'), 'utf8')).toBe('{"x":1}\n');
  });
});
