/**
 * Persisted-state migrator.
 *
 * `workspace.json` is the only file we persist. After REQ-010 the schema is
 * v6: same shape as v5 (REQ-009's per-project view/panel/terminal fields)
 * except the four terminal fields move OUT of `ProjectSession` into a single
 * workspace-global `terminals` object. v5 → v6 is NOT shape-preserving — the
 * terminal state relocates — so a v5 payload is upgraded: the last project's
 * terminal state is hoisted into the global `terminals` slot, then stripped
 * from every per-project session.
 *
 * Policy:
 *
 *   1. Read raw JSON.
 *   2. If `schemaVersion === 6` → trust it, pass through reference-equal.
 *   3. If `schemaVersion === 5` → upgrade to v6: hoist the last project's
 *      terminal state into the global `terminals` field, strip the four
 *      terminal fields from every project session. No backup — v5 has the
 *      user's real projects + tabs + layout; we keep them.
 *   4. If `schemaVersion === 4` → shape-preserving upgrade through to v6:
 *      carry everything, fill `terminals` with empty defaults (v4 had no
 *      terminal state). No backup.
 *   5. If `schemaVersion === 3` → upgrade to v6: carry everything, fill
 *      `enabledPlugins` with `{}` and `terminals` with defaults. No backup.
 *   6. If `schemaVersion === 2` → upgrade through to v6: carry projects +
 *      recents + window, fill `layout`, `enabledPlugins`, and `terminals`
 *      with defaults.
 *   7. If `schemaVersion === 1` → archive the file as `workspace.v1.bak`
 *      and return fresh v6 defaults. There is no shape-preserving upgrade
 *      because the v1 "project = folder + auto-detected repos" model can't
 *      be mapped onto the v2+ "project = named container with user-added
 *      repos" model. Users had no real projects yet — this is the
 *      acceptable trade-off documented in the REQ-003 spec.
 *   8. Anything else (missing version, future version, garbled shape) →
 *      same as v1: archive (this time as `workspace.v0.bak`) + fresh
 *      defaults. Losing tabs is preferable to crashing on launch.
 *
 * The exported signature is `migrate(raw: unknown): PersistedState` —
 * the optional `sourcePath` argument is an internal hook used by
 * `store.ts` and the tests so the archive step can find the file on
 * disk. Callers passing only `raw` get a pure function: defaults are
 * still returned for unrecognised input, the archive step is just a no-op.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LayoutSnapshot, PersistedState } from '../../types/workspace';

/** Filename written next to `workspace.json` when migrating away from v1. */
export const V1_BACKUP_FILENAME = 'workspace.v1.bak';

/** Filename written next to `workspace.json` for unknown / corrupt input. */
export const V0_BACKUP_FILENAME = 'workspace.v0.bak';

/**
 * Back-compat re-export. Older tests imported `BACKUP_FILENAME` (the
 * unknown-input archive name). v1 archives use {@link V1_BACKUP_FILENAME}.
 */
export const BACKUP_FILENAME = V0_BACKUP_FILENAME;

/**
 * Default IDE panel sizes — must stay in sync with `DEFAULT_LAYOUT` on the
 * renderer side (`store/workspaceStore.ts`). Duplicated here so the main
 * process doesn't have to import renderer code.
 */
export const DEFAULT_LAYOUT: LayoutSnapshot = {
  explorerWidth: 256,
  dockWidth: 344,
  panelHeight: 232,
};

/**
 * Empty workspace-global terminal state — REQ-010. Used as the default for
 * fresh installs and whenever an upgrade has no terminal state to hoist
 * (v2–v4 payloads predate terminal persistence entirely).
 */
export const DEFAULT_TERMINALS: PersistedState['terminals'] = {
  panelTerminals: [],
  activePanelTerminalId: null,
  termSessions: [],
  activeTermSessionId: null,
};

/**
 * The shape of a freshly-installed workspace. Returned whenever the on-disk
 * file is missing, malformed, or from a previous schema. Deep-cloned on every
 * call so callers can mutate the result without poisoning subsequent ones.
 */
export function defaults(): PersistedState {
  return {
    schemaVersion: 6,
    lastProjectId: null,
    recents: [],
    projects: {},
    layout: { ...DEFAULT_LAYOUT },
    enabledPlugins: {},
    terminals: {
      panelTerminals: [],
      activePanelTerminalId: null,
      termSessions: [],
      activeTermSessionId: null,
    },
    window: { width: 1480, height: 920 },
  };
}

/**
 * Coerce raw JSON read from `workspace.json` into a {@link PersistedState}.
 *
 * @param raw        Parsed JSON value (or `undefined` if the file was absent).
 * @param sourcePath Absolute path the raw value was read from. When omitted
 *                   the function is pure: it still returns defaults for
 *                   unrecognised input, it just skips the on-disk archive.
 *                   `store.ts` always supplies this.
 *
 * @returns The migrated state. Reference-equal to `raw` when `raw` already
 *          looks like a valid v6 — `store.ts` relies on that to avoid an
 *          unnecessary write on every launch. A v5 payload is upgraded
 *          (terminal state hoisted to the global slot, then stripped from
 *          each project session).
 */
export function migrate(raw: unknown, sourcePath?: string): PersistedState {
  // v6 → pass through reference-equal (store.ts skips the no-op write).
  if (isValidV6(raw)) {
    return raw;
  }
  // v5 → upgrade to v6. Hoist the last project's terminal state into the
  // global `terminals` slot, then strip the four terminal fields from every
  // project session. No backup — v5 has the user's real data.
  if (isValidV5(raw)) {
    return upgradeV5ToV6(raw);
  }
  // v4 → upgrade through to v6. v4 had no terminal state, so the global
  // `terminals` field gets empty defaults. No backup.
  if (isValidV4(raw)) {
    return upgradeV4ToV6(raw);
  }
  // v3 → upgrade through to v6. v3 had real user data; carry it forward,
  // fill `enabledPlugins` with `{}` and `terminals` with defaults. No backup.
  if (isValidV3(raw)) {
    return upgradeV3ToV6(raw);
  }
  // v2 → upgrade through to v6. Carry projects + recents + window, fill new
  // fields (layout, enabledPlugins, terminals) with defaults.
  if (isValidV2(raw)) {
    return upgradeV2ToV6(raw);
  }
  // v1 → archive as workspace.v1.bak, return fresh v6 defaults.
  if (isV1Shape(raw)) {
    if (sourcePath !== undefined) {
      archiveExisting(sourcePath, V1_BACKUP_FILENAME);
    }
    return defaults();
  }
  // Anything else (missing version, future version, garbled) → v0 backup.
  if (sourcePath !== undefined) {
    archiveExisting(sourcePath, V0_BACKUP_FILENAME);
  }
  return defaults();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Internal shape for a v2 payload — the project-model-rewrite schema. Used
 * by the v2 → v4 shape-preserving upgrade path.
 */
interface PersistedStateV2 {
  schemaVersion: 2;
  lastProjectId: string | null;
  recents: PersistedState['recents'];
  projects: PersistedState['projects'];
  window: PersistedState['window'];
}

/**
 * Internal shape for a v3 payload — same as v2 + workspace `layout` field.
 * Used by the v3 → v6 upgrade path.
 */
interface PersistedStateV3 {
  schemaVersion: 3;
  lastProjectId: string | null;
  recents: PersistedState['recents'];
  projects: PersistedState['projects'];
  layout: LayoutSnapshot;
  window: PersistedState['window'];
}

/**
 * One per-project session in a v4/v5 payload. v5 sessions additionally carry
 * the four terminal fields (all optional); the v5 → v6 upgrade reads them off
 * the last project and strips them from every session.
 */
interface ProjectSessionV5 {
  panelTerminals?: PersistedState['terminals']['panelTerminals'];
  activePanelTerminalId?: PersistedState['terminals']['activePanelTerminalId'];
  termSessions?: PersistedState['terminals']['termSessions'];
  activeTermSessionId?: PersistedState['terminals']['activeTermSessionId'];
  [key: string]: unknown;
}

/**
 * Internal shape for a v4 or v5 payload — v3 fields plus `enabledPlugins`.
 * v4 and v5 share an identical *structural* shape (every v5 addition is an
 * optional field inside `ProjectSession`); they differ only by the
 * `schemaVersion` marker, so the upgrade paths branch on that.
 */
interface PersistedStateV4Or5 {
  schemaVersion: 4 | 5;
  lastProjectId: string | null;
  recents: PersistedState['recents'];
  projects: Record<string, ProjectSessionV5>;
  layout: LayoutSnapshot;
  enabledPlugins: Record<string, string[]>;
  window: PersistedState['window'];
}

/**
 * Structural check for a v6 payload — a v4/v5-shaped payload with
 * `schemaVersion === 6` and a well-formed workspace-global `terminals`
 * object (the four fields present with correct types). Used for the
 * reference-equal passthrough.
 */
function isValidV6(raw: unknown): raw is PersistedState {
  if (!hasV4Or5Shape(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 6) return false;

  const t = r.terminals;
  if (t === null || typeof t !== 'object') return false;
  const term = t as Record<string, unknown>;
  if (!Array.isArray(term.panelTerminals)) return false;
  if (!Array.isArray(term.termSessions)) return false;
  if (
    term.activePanelTerminalId !== null &&
    typeof term.activePanelTerminalId !== 'string'
  )
    return false;
  if (
    term.activeTermSessionId !== null &&
    typeof term.activeTermSessionId !== 'string'
  )
    return false;
  return true;
}

/** Structural check for a v5 payload (v4/v5 shape + `schemaVersion === 5`). */
function isValidV5(raw: unknown): raw is PersistedStateV4Or5 {
  if (!hasV4Or5Shape(raw)) return false;
  return (raw as Record<string, unknown>).schemaVersion === 5;
}

/** Structural check for a v4 payload (v4/v5 shape + `schemaVersion === 4`). */
function isValidV4(raw: unknown): raw is PersistedStateV4Or5 {
  if (!hasV4Or5Shape(raw)) return false;
  return (raw as Record<string, unknown>).schemaVersion === 4;
}

/**
 * Shared structural check for v4-and-up fields — v3 fields plus a
 * well-formed `enabledPlugins` map (each value an array of strings).
 */
function hasV4Or5Shape(raw: unknown): boolean {
  if (!hasV3Shape(raw)) return false;
  const r = raw as Record<string, unknown>;

  const ep = r.enabledPlugins;
  if (ep === null || typeof ep !== 'object') return false;
  for (const v of Object.values(ep as Record<string, unknown>)) {
    if (!Array.isArray(v)) return false;
    if (!v.every((s) => typeof s === 'string')) return false;
  }
  return true;
}

/**
 * Structural check for a v3 payload. Used both for the v3 → v4 upgrade
 * and (indirectly) for the v4 layout check, which extends it.
 */
function isValidV3(raw: unknown): raw is PersistedStateV3 {
  if (!hasV3Shape(raw)) return false;
  const r = raw as Record<string, unknown>;
  return r.schemaVersion === 3;
}

/**
 * Shared structural check for v3-and-up fields (v2 fields plus `layout`).
 */
function hasV3Shape(raw: unknown): boolean {
  if (!hasV2Shape(raw)) return false;
  const r = raw as Record<string, unknown>;

  const layout = r.layout;
  if (layout === null || typeof layout !== 'object') return false;
  const l = layout as Record<string, unknown>;
  if (typeof l.explorerWidth !== 'number') return false;
  if (typeof l.dockWidth !== 'number') return false;
  if (typeof l.panelHeight !== 'number') return false;

  return true;
}

/**
 * Structural check for a v2 payload — same top-level fields as v3 minus
 * `layout`.
 */
function isValidV2(raw: unknown): raw is PersistedStateV2 {
  if (!hasV2Shape(raw)) return false;
  const r = raw as Record<string, unknown>;
  return r.schemaVersion === 2;
}

/**
 * Shared structural check for the v2-and-up fields (`lastProjectId`,
 * `recents`, `projects`, `window`).
 */
function hasV2Shape(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;

  if (r.lastProjectId !== null && typeof r.lastProjectId !== 'string') return false;
  if (!Array.isArray(r.recents)) return false;
  if (r.projects === null || typeof r.projects !== 'object') return false;

  const win = r.window;
  if (win === null || typeof win !== 'object') return false;
  const w = win as Record<string, unknown>;
  if (typeof w.width !== 'number' || typeof w.height !== 'number') return false;

  return true;
}

/**
 * Upgrade from v5 → v6: relocate terminal state from per-project to global.
 *
 * - HOIST: if `lastProjectId` resolves to a project session that carries
 *   terminal state, copy its four terminal fields into the new global
 *   `terminals` slot. This preserves the user's current terminals across the
 *   upgrade. Otherwise the global `terminals` is empty.
 * - STRIP: remove the four terminal fields from every project session so the
 *   per-project shape matches the v6 `ProjectSession` (no terminal fields).
 *
 * Everything else (lastProjectId, recents, layout, enabledPlugins, window)
 * carries over unchanged.
 */
function upgradeV5ToV6(v5: PersistedStateV4Or5): PersistedState {
  const last =
    v5.lastProjectId !== null ? v5.projects[v5.lastProjectId] : undefined;
  const terminals: PersistedState['terminals'] = {
    panelTerminals: last?.panelTerminals ?? [],
    activePanelTerminalId: last?.activePanelTerminalId ?? null,
    termSessions: last?.termSessions ?? [],
    activeTermSessionId: last?.activeTermSessionId ?? null,
  };

  const projects: PersistedState['projects'] = {};
  for (const [id, session] of Object.entries(v5.projects)) {
    const {
      panelTerminals: _pt,
      activePanelTerminalId: _api,
      termSessions: _ts,
      activeTermSessionId: _ati,
      ...rest
    } = session;
    void _pt;
    void _api;
    void _ts;
    void _ati;
    // `rest` is a structurally-checked raw session minus the terminal fields;
    // the migrator works at the JSON level, so cast through `unknown`.
    projects[id] = rest as unknown as PersistedState['projects'][string];
  }

  return {
    schemaVersion: 6,
    lastProjectId: v5.lastProjectId,
    recents: v5.recents,
    projects,
    layout: v5.layout,
    enabledPlugins: v5.enabledPlugins,
    terminals,
    window: v5.window,
  };
}

/**
 * Upgrade from v4 → v6: carry every existing field forward and fill the new
 * workspace-global `terminals` field with empty defaults. v4 predates
 * terminal persistence, so there is nothing to hoist.
 */
function upgradeV4ToV6(v4: PersistedStateV4Or5): PersistedState {
  return {
    schemaVersion: 6,
    lastProjectId: v4.lastProjectId,
    recents: v4.recents,
    // v4 sessions have no terminal fields; the structural shape matches the
    // v6 ProjectSession. Cast through `unknown` since the migrator is JSON-level.
    projects: v4.projects as unknown as PersistedState['projects'],
    layout: v4.layout,
    enabledPlugins: v4.enabledPlugins,
    terminals: { ...DEFAULT_TERMINALS },
    window: v4.window,
  };
}

/**
 * Upgrade from v3 → v6: copy every existing field, add the `enabledPlugins`
 * field as `{}`, and fill the new `terminals` field with empty defaults.
 */
function upgradeV3ToV6(v3: PersistedStateV3): PersistedState {
  return {
    schemaVersion: 6,
    lastProjectId: v3.lastProjectId,
    recents: v3.recents,
    projects: v3.projects,
    layout: v3.layout,
    enabledPlugins: {},
    terminals: { ...DEFAULT_TERMINALS },
    window: v3.window,
  };
}

/**
 * Upgrade from v2 → v6: carry the v2 fields forward and fill the v3
 * (`layout`), v4 (`enabledPlugins`), and v6 (`terminals`) additions with
 * defaults.
 */
function upgradeV2ToV6(v2: PersistedStateV2): PersistedState {
  return {
    schemaVersion: 6,
    lastProjectId: v2.lastProjectId,
    recents: v2.recents,
    projects: v2.projects,
    layout: { ...DEFAULT_LAYOUT },
    enabledPlugins: {},
    terminals: { ...DEFAULT_TERMINALS },
    window: v2.window,
  };
}

/** Cheap shape check that just looks at the top-level `schemaVersion`. */
function isV1Shape(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return r.schemaVersion === 1;
}

/**
 * Copy the source file to `archiveName` in the same directory.
 *
 * Silent if the source file doesn't exist (fresh install — nothing to
 * archive). Errors are swallowed and logged: failing to back up an old
 * file is bad, but crashing the app on launch is worse.
 */
function archiveExisting(sourcePath: string, archiveName: string): void {
  try {
    if (!existsSync(sourcePath)) return;
    const backupPath = join(dirname(sourcePath), archiveName);
    copyFileSync(sourcePath, backupPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[state.migrate] failed to archive existing workspace file:', err);
  }
}
