/**
 * migrate() — REQ-002 / STORY-019.
 *
 * One test per branch of the migration policy from the design doc:
 *
 *   - missing version → defaults + backup
 *   - future version  → defaults + backup
 *   - valid v1        → pass-through, no backup
 *
 * Plus a couple of sanity cases for the corners (fresh install, malformed
 * shape) that proved easy to get wrong while writing this.
 */

import { promises as fsp } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import mockFs from 'mock-fs';

import { BACKUP_FILENAME, defaults, migrate } from './migrate';
import type { PersistedState } from '../../types/workspace';

const SOURCE_DIR = '/var/hive-store';
const SOURCE_PATH = `${SOURCE_DIR}/workspace.json`;
const BACKUP_PATH = `${SOURCE_DIR}/${BACKUP_FILENAME}`;

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

  // --- missing version ------------------------------------------------------

  it('archives the existing file and returns defaults when schemaVersion is missing', async () => {
    const stale = { lastProjectId: 'p-old', recents: [{ id: 'p-old' }] };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(stale),
      },
    });

    const result = migrate(stale, SOURCE_PATH);

    expect(result).toEqual(defaults());
    expect(await exists(BACKUP_PATH)).toBe(true);
    expect(await readJson(BACKUP_PATH)).toEqual(stale);
  });

  // --- future version -------------------------------------------------------

  it('archives the existing file and returns defaults when schemaVersion is from the future', async () => {
    const future = { schemaVersion: 99, somethingNew: 'tbd', projects: {} };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(future),
      },
    });

    const result = migrate(future, SOURCE_PATH);

    expect(result.schemaVersion).toBe(1);
    expect(result).toEqual(defaults());
    expect(await exists(BACKUP_PATH)).toBe(true);
    expect(await readJson(BACKUP_PATH)).toEqual(future);
  });

  // --- valid v1 -------------------------------------------------------------

  it('passes a valid v1 payload through unchanged and does not write a backup', async () => {
    const valid: PersistedState = {
      schemaVersion: 1,
      lastProjectId: 'p-current',
      recents: [
        {
          id: 'p-current',
          name: 'acme',
          rootPath: '/work/acme',
          source: 'hive',
          repoCount: 2,
          lastOpenedAt: 1_700_000_000_000,
        },
      ],
      projects: {
        'p-current': {
          id: 'p-current',
          rootPath: '/work/acme',
          name: 'acme',
          source: 'hive',
          expandedPaths: ['/work/acme/repos/web'],
          openTabs: [{ path: '/work/acme/repos/web/README.md', viewState: null }],
          activeTabPath: '/work/acme/repos/web/README.md',
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
    expect(await exists(BACKUP_PATH)).toBe(false);
  });

  // --- corners --------------------------------------------------------------

  it('returns defaults without crashing when raw is undefined and no source path is given (fresh install)', () => {
    const result = migrate(undefined);
    expect(result).toEqual(defaults());
  });

  it('returns defaults and does not write a backup when the source file does not exist', async () => {
    mockFs({
      [SOURCE_DIR]: {
        /* directory exists but workspace.json does not */
      },
    });

    const result = migrate(undefined, SOURCE_PATH);

    expect(result).toEqual(defaults());
    expect(await exists(BACKUP_PATH)).toBe(false);
  });

  it('treats a v1 payload missing top-level keys as needing migration', async () => {
    const malformed = { schemaVersion: 1 }; // no recents/projects/window
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(malformed),
      },
    });

    const result = migrate(malformed, SOURCE_PATH);

    expect(result).toEqual(defaults());
    expect(await exists(BACKUP_PATH)).toBe(true);
  });

  it('overwrites a prior backup when the file needs re-archiving', async () => {
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify({ schemaVersion: 2 }),
        [BACKUP_FILENAME]: 'stale backup contents',
      },
    });

    migrate({ schemaVersion: 2 }, SOURCE_PATH);

    expect(await readJson(BACKUP_PATH)).toEqual({ schemaVersion: 2 });
  });
});
