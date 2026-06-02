/**
 * migrate() — schema migration.
 *
 * One test per branch of the migration policy:
 *
 *   - valid v2        → pass-through, no backup
 *   - v1 payload      → archive as workspace.v1.bak, return v2 defaults
 *   - missing version → archive as workspace.v0.bak, return v2 defaults
 *   - future version  → archive as workspace.v0.bak, return v2 defaults
 *
 * Plus corner cases for fresh install and malformed shapes.
 */

import { promises as fsp } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import mockFs from 'mock-fs';

import {
  V0_BACKUP_FILENAME,
  V1_BACKUP_FILENAME,
  defaults,
  migrate,
} from './migrate';
import type { PersistedState } from '../../types/workspace';

const SOURCE_DIR = '/var/hive-store';
const SOURCE_PATH = `${SOURCE_DIR}/workspace.json`;
const V0_BACKUP_PATH = `${SOURCE_DIR}/${V0_BACKUP_FILENAME}`;
const V1_BACKUP_PATH = `${SOURCE_DIR}/${V1_BACKUP_FILENAME}`;

async function readJson(path: string): Promise<unknown> {
  const raw = await fsp.readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

describe('migrate()', () => {
  afterEach(() => {
    mockFs.restore();
  });

  // --- valid v2 ------------------------------------------------------------

  it('passes a valid v2 payload through unchanged and does not write a backup', async () => {
    const valid: PersistedState = {
      schemaVersion: 2,
      lastProjectId: 'p-current',
      recents: [
        {
          id: 'p-current',
          name: 'acme',
          repoCount: 2,
          lastOpenedAt: 1_700_000_000_000,
        },
      ],
      projects: {
        'p-current': {
          id: 'p-current',
          name: 'acme',
          repos: [
            { name: 'web', path: '/work/acme/web', isGitRepo: true },
          ],
          createdAt: 1_600_000_000_000,
          lastOpenedAt: 1_700_000_000_000,
          expandedPaths: ['/work/acme/web'],
          openTabs: [{ path: '/work/acme/web/README.md', viewState: null }],
          activeTabPath: '/work/acme/web/README.md',
        },
      },
      window: { width: 1600, height: 1000, x: 40, y: 40 },
    };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(valid),
      },
    });

    const result = migrate(valid, SOURCE_PATH);

    // Reference-equal — store.ts uses this to skip the no-op write on launch.
    expect(result).toBe(valid);
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
    expect(await exists(V1_BACKUP_PATH)).toBe(false);
  });

  // --- v1 → v2 -------------------------------------------------------------

  it('archives a v1 payload as workspace.v1.bak and returns v2 defaults', async () => {
    const oldV1 = {
      schemaVersion: 1,
      lastProjectId: 'sha1-xyz',
      recents: [
        {
          id: 'sha1-xyz',
          name: 'demo',
          rootPath: '/Users/me/demo',
          source: 'auto-detected',
          repoCount: 2,
          lastOpenedAt: 0,
        },
      ],
      projects: {},
      window: { width: 1480, height: 920 },
    };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(oldV1),
      },
    });

    const result = migrate(oldV1, SOURCE_PATH);

    expect(result).toEqual(defaults());
    expect(result.schemaVersion).toBe(2);
    expect(await exists(V1_BACKUP_PATH)).toBe(true);
    expect(await readJson(V1_BACKUP_PATH)).toEqual(oldV1);
    // v0 backup is for unknown shapes, not v1; don't write both.
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
  });

  // --- missing version -----------------------------------------------------

  it('archives the existing file as workspace.v0.bak and returns defaults when schemaVersion is missing', async () => {
    const stale = { lastProjectId: 'p-old', recents: [{ id: 'p-old' }] };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(stale),
      },
    });

    const result = migrate(stale, SOURCE_PATH);

    expect(result).toEqual(defaults());
    expect(await exists(V0_BACKUP_PATH)).toBe(true);
    expect(await readJson(V0_BACKUP_PATH)).toEqual(stale);
  });

  // --- future version ------------------------------------------------------

  it('archives a future-version payload as workspace.v0.bak and returns defaults', async () => {
    const future = { schemaVersion: 99, somethingNew: 'tbd', projects: {} };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(future),
      },
    });

    const result = migrate(future, SOURCE_PATH);

    expect(result.schemaVersion).toBe(2);
    expect(result).toEqual(defaults());
    expect(await exists(V0_BACKUP_PATH)).toBe(true);
    expect(await readJson(V0_BACKUP_PATH)).toEqual(future);
  });

  // --- corners --------------------------------------------------------------

  it('returns defaults without crashing when raw is undefined and no source path is given (fresh install)', () => {
    const result = migrate(undefined);
    expect(result).toEqual(defaults());
    expect(result.schemaVersion).toBe(2);
  });

  it('returns defaults and does not write a backup when the source file does not exist', async () => {
    mockFs({
      [SOURCE_DIR]: {
        /* directory exists but workspace.json does not */
      },
    });

    const result = migrate(undefined, SOURCE_PATH);

    expect(result).toEqual(defaults());
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
    expect(await exists(V1_BACKUP_PATH)).toBe(false);
  });

  it('overwrites a prior v0 backup when the file needs re-archiving', async () => {
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify({ schemaVersion: 99 }),
        [V0_BACKUP_FILENAME]: 'stale backup contents',
      },
    });

    migrate({ schemaVersion: 99 }, SOURCE_PATH);

    expect(await readJson(V0_BACKUP_PATH)).toEqual({ schemaVersion: 99 });
  });
});
