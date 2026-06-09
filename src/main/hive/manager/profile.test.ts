import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serializeProfile, parseProfile, readProfiles } from './profile';
import type { RepoProfile } from '../../../types/hive';

const sample: RepoProfile = {
  repo: 'bff-web',
  indexedAt: '2026-06-09T16:40:00Z',
  commit: 'abc1234',
  body: 'Purpose: customer-facing web BFF.\nStack: TypeScript.\nTest: `npm test`.',
};

describe('serializeProfile / parseProfile', () => {
  it('round-trips a full profile', () => {
    expect(parseProfile(serializeProfile(sample), 'bff-web')).toEqual(sample);
  });

  it('round-trips a profile with no commit (omits the key)', () => {
    const p: RepoProfile = { repo: 'policy', indexedAt: '2026-06-09T10:00:00Z', body: 'Purpose: policy svc.' };
    const raw = serializeProfile(p);
    expect(raw).not.toContain('commit:');
    expect(parseProfile(raw, 'policy')).toEqual(p);
  });

  it('always takes repo from the passed-in stem, not the frontmatter', () => {
    const raw = serializeProfile(sample);
    expect(parseProfile(raw, 'renamed').repo).toBe('renamed');
  });

  it('tolerates a file with no frontmatter', () => {
    const p = parseProfile('just a body, no fences', 'x');
    expect(p.repo).toBe('x');
    expect(p.indexedAt).toBe('');
    expect(p.commit).toBeUndefined();
    expect(p.body).toBe('just a body, no fences');
  });
});

describe('readProfiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'hive-profiles-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing dir', async () => {
    expect(await readProfiles(join(dir, 'nope'))).toEqual([]);
  });

  it('reads and parses every .md, ignoring non-md', async () => {
    await fs.writeFile(join(dir, 'bff-web.md'), serializeProfile(sample), 'utf8');
    await fs.writeFile(join(dir, 'README.txt'), 'ignore me', 'utf8');
    const out = await readProfiles(dir);
    expect(out).toEqual([sample]);
  });
});
