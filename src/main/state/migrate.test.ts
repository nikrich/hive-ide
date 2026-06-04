/**
 * migrate() — schema migration.
 *
 * One test per branch of the migration policy (REQ-010, v6):
 *
 *   - valid v6        → pass-through reference-equal, no backup
 *   - v5 payload      → upgrade to v6: hoist last project's terminal state to
 *                       global `terminals`, strip it from each session
 *   - v4 payload      → upgrade through to v6, fill `terminals` with defaults
 *   - v3 payload      → upgrade through to v6, add `enabledPlugins: {}` +
 *                       `terminals` defaults
 *   - v2 payload      → upgrade through to v6, fill new fields (layout +
 *                       enabledPlugins + terminals) with defaults
 *   - v1 payload      → archive as workspace.v1.bak, return v6 defaults
 *   - missing version → archive as workspace.v0.bak, return v6 defaults
 *   - future version  → archive as workspace.v0.bak, return v6 defaults
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

  // --- valid v6 ------------------------------------------------------------

  it('passes a valid v6 payload through unchanged and does not write a backup', async () => {
    const valid: PersistedState = {
      schemaVersion: 6,
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
      terminals: {
        panelTerminals: [{ tabId: 't1', title: 'build', cwd: '/work/acme' }],
        activePanelTerminalId: 't1',
        termSessions: [],
        activeTermSessionId: null,
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

  // --- v5 → v6 (hoist terminals) -------------------------------------------

  it('upgrades a v5 payload to v6 — hoists the last project terminal state to global, strips it from each session', async () => {
    const oldV5 = {
      schemaVersion: 5,
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
          repos: [{ name: 'web', path: '/work/acme/web', isGitRepo: true }],
          createdAt: 1_600_000_000_000,
          lastOpenedAt: 1_700_000_000_000,
          expandedPaths: ['/work/acme/web'],
          openTabs: [{ path: '/work/acme/web/README.md', viewState: null }],
          activeTabPath: '/work/acme/web/README.md',
          activeView: 'term',
          panelOpen: true,
          panelTab: 'terminal',
          panelTerminals: [{ tabId: 't1', title: 'dev', cwd: '/work/acme/web' }],
          activePanelTerminalId: 't1',
          termSessions: [
            {
              id: 's1',
              group: 'acme',
              title: 'logs',
              branch: 'main',
              root: { type: 'pane', id: 'pane-1' },
              activePane: 'pane-1',
              panes: { 'pane-1': { title: 'logs', cwd: '/work/acme/web', branch: 'main' } },
            },
          ],
          activeTermSessionId: 's1',
        },
        'p-other': {
          id: 'p-other',
          name: 'other',
          repos: [],
          createdAt: 1_600_000_000_000,
          lastOpenedAt: 1_650_000_000_000,
          expandedPaths: [],
          openTabs: [],
          activeTabPath: null,
          panelTerminals: [{ tabId: 'tx', title: 'should-not-hoist' }],
          activePanelTerminalId: 'tx',
        },
      },
      layout: { explorerWidth: 280, dockWidth: 360, panelHeight: 220 },
      enabledPlugins: { 'p-current': ['hive-ide/example-hello'] },
      window: { width: 1600, height: 1000 },
    };
    mockFs({
      [SOURCE_DIR]: {
        'workspace.json': JSON.stringify(oldV5),
      },
    });

    const result = migrate(oldV5, SOURCE_PATH);

    expect(result.schemaVersion).toBe(6);
    expect(result.lastProjectId).toBe('p-current');
    expect(result.layout).toEqual(oldV5.layout);
    expect(result.enabledPlugins).toEqual(oldV5.enabledPlugins);
    expect(result.window).toEqual(oldV5.window);

    // The last project's terminal state is hoisted into the global slot.
    expect(result.terminals.panelTerminals).toEqual([
      { tabId: 't1', title: 'dev', cwd: '/work/acme/web' },
    ]);
    expect(result.terminals.activePanelTerminalId).toBe('t1');
    expect(result.terminals.termSessions).toHaveLength(1);
    expect(result.terminals.termSessions[0].id).toBe('s1');
    expect(result.terminals.activeTermSessionId).toBe('s1');

    // Per-project sessions no longer carry any terminal fields.
    for (const session of Object.values(result.projects)) {
      const s = session as Record<string, unknown>;
      expect(s.panelTerminals).toBeUndefined();
      expect(s.activePanelTerminalId).toBeUndefined();
      expect(s.termSessions).toBeUndefined();
      expect(s.activeTermSessionId).toBeUndefined();
    }
    // The non-view/panel/terminal fields on each session survive.
    expect(result.projects['p-current'].activeView).toBe('term');
    expect(result.projects['p-current'].panelTab).toBe('terminal');
    expect(result.projects['p-current'].activeTabPath).toBe(
      '/work/acme/web/README.md',
    );

    // No backup — v5 has the user's real data.
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
    expect(await exists(V1_BACKUP_PATH)).toBe(false);
  });

  it('upgrades a v5 payload with no terminal state to v6 with empty global terminals', async () => {
    const oldV5 = {
      schemaVersion: 5,
      lastProjectId: 'p-current',
      recents: [],
      projects: {
        'p-current': {
          id: 'p-current',
          name: 'acme',
          repos: [],
          createdAt: 0,
          lastOpenedAt: 0,
          expandedPaths: [],
          openTabs: [],
          activeTabPath: null,
        },
      },
      layout: DEFAULT_LAYOUT,
      enabledPlugins: {},
      window: { width: 1440, height: 900 },
    };
    mockFs({ [SOURCE_DIR]: { 'workspace.json': JSON.stringify(oldV5) } });

    const result = migrate(oldV5, SOURCE_PATH);

    expect(result.schemaVersion).toBe(6);
    expect(result.terminals).toEqual({
      panelTerminals: [],
      activePanelTerminalId: null,
      termSessions: [],
      activeTermSessionId: null,
    });
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
  });

  // --- v4 → v6 -------------------------------------------------------------

  it('upgrades a valid v4 payload to v6, preserving every field, filling terminals with defaults, and writes no backup', async () => {
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

    expect(result.schemaVersion).toBe(6);
    expect(result.lastProjectId).toBe('p-hive');
    expect(result.recents).toEqual(oldV4.recents);
    expect(result.projects).toEqual(oldV4.projects);
    expect(result.layout).toEqual(oldV4.layout);
    expect(result.enabledPlugins).toEqual({});
    expect(result.terminals).toEqual({
      panelTerminals: [],
      activePanelTerminalId: null,
      termSessions: [],
      activeTermSessionId: null,
    });
    expect(result.window).toEqual(oldV4.window);
    expect(result.projects['p-hive'].hiveWorkspacePath).toBe(
      '/Users/me/hive-workspaces/project-x',
    );
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
    expect(await exists(V1_BACKUP_PATH)).toBe(false);
  });

  // --- v3 → v6 -------------------------------------------------------------

  it('upgrades a v3 payload to v6 in place — carries layout forward, fills enabledPlugins with {}', async () => {
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

    expect(result.schemaVersion).toBe(6);
    expect(result.lastProjectId).toBe('p-current');
    expect(result.recents).toEqual(oldV3.recents);
    expect(result.projects).toEqual(oldV3.projects);
    expect(result.layout).toEqual(oldV3.layout);
    expect(result.window).toEqual(oldV3.window);
    // New fields are initialised to empty defaults.
    expect(result.enabledPlugins).toEqual({});
    expect(result.terminals).toEqual({
      panelTerminals: [],
      activePanelTerminalId: null,
      termSessions: [],
      activeTermSessionId: null,
    });
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
    expect(await exists(V1_BACKUP_PATH)).toBe(false);
  });

  // --- v2 → v6 -------------------------------------------------------------

  it('upgrades a v2 payload through to v6 — fills layout + enabledPlugins + terminals with defaults', async () => {
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

    expect(result.schemaVersion).toBe(6);
    expect(result.lastProjectId).toBe('p-current');
    expect(result.recents).toEqual(oldV2.recents);
    expect(result.projects).toEqual(oldV2.projects);
    expect(result.window).toEqual(oldV2.window);
    expect(result.layout).toEqual(DEFAULT_LAYOUT);
    expect(result.enabledPlugins).toEqual({});
    expect(result.terminals).toEqual({
      panelTerminals: [],
      activePanelTerminalId: null,
      termSessions: [],
      activeTermSessionId: null,
    });
    expect(await exists(V0_BACKUP_PATH)).toBe(false);
    expect(await exists(V1_BACKUP_PATH)).toBe(false);
  });

  // --- v1 → v6 -------------------------------------------------------------

  it('archives a v1 payload as workspace.v1.bak and returns v6 defaults', async () => {
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
    expect(result.schemaVersion).toBe(6);
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

    expect(result.schemaVersion).toBe(6);
    expect(result).toEqual(defaults());
    expect(await exists(V0_BACKUP_PATH)).toBe(true);
    expect(await readJson(V0_BACKUP_PATH)).toEqual(future);
  });

  // --- corners --------------------------------------------------------------

  it('returns defaults without crashing when raw is undefined and no source path is given (fresh install)', () => {
    const result = migrate(undefined);
    expect(result).toEqual(defaults());
    expect(result.schemaVersion).toBe(6);
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
