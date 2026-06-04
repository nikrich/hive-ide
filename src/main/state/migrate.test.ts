/**
 * migrate() — schema migration.
 *
 * One test per branch of the migration policy (REQ-009, v5):
 *
 *   - valid v5        → pass-through, no backup
 *   - valid v4        → shape-preserving re-stamp to v5, no backup
 *   - v3 payload      → shape-preserving upgrade, add `enabledPlugins: {}`
 *   - v2 payload      → shape-preserving upgrade through to v5, fill new
 *                       fields (layout + enabledPlugins) with defaults
 *   - v1 payload      → archive as workspace.v1.bak, return v5 defaults
 *   - missing version → archive as workspace.v0.bak, return v5 defaults
 *   - future version  → archive as workspace.v0.bak, return v5 defaults
 *
 * Plus corner cases for fresh install and malformed shapes.
 */

import { promises as fsp } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import mockFs from 'mock-fs';

import {
  DEFAULT_LAYOUT,
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

  // --- valid v5 ------------------------------------------------------------

  it('passes a valid v5 payload through unchanged and does not write a backup', async () => {
    const valid: PersistedState = {
      schemaVersion: 5,
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
      layout: { explorerWidth: 300, dockWidth: 400, panelHeight: 250 },
      enabledPlugins: { 'p-current': ['hive-ide/example-hello'] },
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

  // --- v4 → v5 re-stamp -----------------------------------------------------

  it('re-stamps a valid v4 payload to v5, preserving every field, and writes no backup', async () => {
    const oldV4 = {
      schemaVersion: 4,
      lastProjectId: 'p-hive',
      recents: [
        {
          id: 'p-hive',
          name: 'hive-project',
          repoCount: 1,
          lastOpenedAt: 1_700_000_000_000,
        },
      ],
      projects: {
        'p-hive': {
          id: 'p-hive',
          name: 'hive-project',
          repos: [{ name: 'repo', path: '/work/repo', isGitRepo: true }],
          createdAt: 1_600_000_000_000,
          lastOpenedAt: 1_700_000_000_000,
          expandedPaths: [],
          openTabs: [],
          activeTabPath: null,
          hiveWorkspacePath: '/Users/me/hive-workspaces/project-x',
        },
      },
      layout: DEFAULT_LAYOUT,
      enabledPlugins: {},
      window: { width: 1440, height: 900 },
    };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(oldV4),
      },
    });

    const result = migrate(oldV4, SOURCE_PATH);

    // Shape-preserving: only the version marker changes; all data carries over.
    expect(result.schemaVersion).toBe(5);
    expect(result.lastProjectId).toBe('p-hive');
    expect(result.recents).toEqual(oldV4.recents);
    expect(result.projects).toEqual(oldV4.projects);
    expect(result.layout).toEqual(oldV4.layout);
    expect(result.enabledPlugins).toEqual({});
    expect(result.window).toEqual(oldV4.window);
    expect(result.projects['p-hive'].hiveWorkspacePath).toBe(
      '/Users/me/hive-workspaces/project-x',
    );
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
    expect(await exists(V1_BACKUP_PATH)).toBe(false);
  });

  // --- v3 → v5 -------------------------------------------------------------

  it('upgrades a v3 payload to v5 in place — carries layout forward, fills enabledPlugins with {}', async () => {
    const oldV3 = {
      schemaVersion: 3,
      lastProjectId: 'p-current',
      recents: [
        {
          id: 'p-current',
          name: 'acme',
          repoCount: 1,
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
      layout: { explorerWidth: 280, dockWidth: 360, panelHeight: 220 },
      window: { width: 1600, height: 1000 },
    };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(oldV3),
      },
    });

    const result = migrate(oldV3, SOURCE_PATH);

    expect(result.schemaVersion).toBe(5);
    expect(result.lastProjectId).toBe('p-current');
    expect(result.recents).toEqual(oldV3.recents);
    expect(result.projects).toEqual(oldV3.projects);
    expect(result.layout).toEqual(oldV3.layout);
    expect(result.window).toEqual(oldV3.window);
    // New field is initialised to an empty record.
    expect(result.enabledPlugins).toEqual({});
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
    expect(await exists(V1_BACKUP_PATH)).toBe(false);
  });

  // --- v2 → v5 -------------------------------------------------------------

  it('upgrades a v2 payload through to v5 — fills layout + enabledPlugins with defaults', async () => {
    const oldV2 = {
      schemaVersion: 2,
      lastProjectId: 'p-current',
      recents: [
        {
          id: 'p-current',
          name: 'acme',
          repoCount: 1,
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
      window: { width: 1600, height: 1000 },
    };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(oldV2),
      },
    });

    const result = migrate(oldV2, SOURCE_PATH);

    expect(result.schemaVersion).toBe(5);
    expect(result.lastProjectId).toBe('p-current');
    expect(result.recents).toEqual(oldV2.recents);
    expect(result.projects).toEqual(oldV2.projects);
    expect(result.window).toEqual(oldV2.window);
    expect(result.layout).toEqual(DEFAULT_LAYOUT);
    expect(result.enabledPlugins).toEqual({});
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
    expect(await exists(V1_BACKUP_PATH)).toBe(false);
  });

  // --- v1 → v5 -------------------------------------------------------------

  it('archives a v1 payload as workspace.v1.bak and returns v5 defaults', async () => {
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
    expect(result.schemaVersion).toBe(5);
    expect(result.enabledPlugins).toEqual({});
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

    expect(result.schemaVersion).toBe(5);
    expect(result).toEqual(defaults());
    expect(await exists(V0_BACKUP_PATH)).toBe(true);
    expect(await readJson(V0_BACKUP_PATH)).toEqual(future);
  });

  // --- corners --------------------------------------------------------------

  it('returns defaults without crashing when raw is undefined and no source path is given (fresh install)', () => {
    const result = migrate(undefined);
    expect(result).toEqual(defaults());
    expect(result.schemaVersion).toBe(5);
    expect(result.enabledPlugins).toEqual({});
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
