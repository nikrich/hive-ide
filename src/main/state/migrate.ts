/**
 * Persisted-state migrator.
 *
 * `workspace.json` is the only file we persist. After REQ-009 the schema is
 * v5: same shape as v4 (REQ-006's `enabledPlugins`) plus optional per-project
 * active-view / bottom-panel / terminal-session fields. v4 → v5 is
 * shape-preserving — every new field is optional and lives inside the
 * `ProjectSession` block — so a v4 payload is accepted as-is and simply
 * re-stamped to v5.
 *
 * Policy:
 *
 *   1. Read raw JSON.
 *   2. If `schemaVersion === 4` or `5` → trust it, pass through (re-stamped v5).
 *   3. If `schemaVersion === 3` → shape-preserving upgrade: carry everything
 *      over and fill `enabledPlugins` with `{}`. No backup is written — v3
 *      contains the user's real projects + tabs + layout; we keep them.
 *   4. If `schemaVersion === 2` → shape-preserving upgrade through to v5:
 *      carry projects + recents + window, fill `layout` and `enabledPlugins`
 *      with defaults.
 *   5. If `schemaVersion === 1` → archive the file as `workspace.v1.bak`
 *      and return fresh v5 defaults. There is no shape-preserving upgrade
 *      because the v1 "project = folder + auto-detected repos" model can't
 *      be mapped onto the v2+ "project = named container with user-added
 *      repos" model. Users had no real projects yet — this is the
 *      acceptable trade-off documented in the REQ-003 spec.
 *   6. Anything else (missing version, future version, garbled shape) →
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
 * The shape of a freshly-installed workspace. Returned whenever the on-disk
 * file is missing, malformed, or from a previous schema. Deep-cloned on every
 * call so callers can mutate the result without poisoning subsequent ones.
 */
export function defaults(): PersistedState {
  return {
    schemaVersion: 5,
    lastProjectId: null,
    recents: [],
    projects: {},
    layout: { ...DEFAULT_LAYOUT },
    enabledPlugins: {},
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
 *          looks like a valid v5 — `store.ts` relies on that to avoid an
 *          unnecessary write on every launch. A v4 payload is shape-identical
 *          (the v5 additions are all optional) so it is re-stamped to v5.
 */
export function migrate(raw: unknown, sourcePath?: string): PersistedState {
  if (isValidV4OrV5(raw)) {
    // v5 → pass through reference-equal (store.ts skips the no-op write).
    // v4 → shape-preserving re-stamp to v5; every v5 field is optional.
    if (raw.schemaVersion === 5) return raw;
    return { ...raw, schemaVersion: 5 };
  }
  // v3 → shape-preserving upgrade. v3 had real user data; carry it forward
  // and fill the new `enabledPlugins` field with an empty map. No backup.
  if (isValidV3(raw)) {
    return upgradeV3ToV5(raw);
  }
  // v2 → shape-preserving upgrade through to v5. Carry projects + recents +
  // window, fill new fields (layout, enabledPlugins) with defaults.
  if (isValidV2(raw)) {
    return upgradeV2ToV5(raw);
  }
  // v1 → archive as workspace.v1.bak, return fresh v5 defaults.
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
 * Used by the v3 → v4 shape-preserving upgrade path.
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
 * Structural check for a v4-or-v5 payload — v3 fields plus `enabledPlugins`.
 * v4 and v5 share an identical structural shape (every v5 addition is an
 * optional field inside `ProjectSession`), so one check covers both; the
 * caller re-stamps a v4 payload to v5.
 */
function isValidV4OrV5(raw: unknown): raw is PersistedState {
  if (!hasV3Shape(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 4 && r.schemaVersion !== 5) return false;

  const ep = r.enabledPlugins;
  if (ep === null || typeof ep !== 'object') return false;
  // Every value must be an array of strings.
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
 * Shape-preserving upgrade from v3 → v5: copy every existing field, bump
 * the version marker, and add the new `enabledPlugins` field as `{}`. The
 * v5 per-project session additions are all optional, so nothing else is
 * needed.
 */
function upgradeV3ToV5(v3: PersistedStateV3): PersistedState {
  return {
    schemaVersion: 5,
    lastProjectId: v3.lastProjectId,
    recents: v3.recents,
    projects: v3.projects,
    layout: v3.layout,
    enabledPlugins: {},
    window: v3.window,
  };
}

/**
 * Shape-preserving upgrade from v2 → v5: carry the v2 fields forward and
 * fill the v3 (`layout`) and v4 (`enabledPlugins`) additions with defaults.
 * The v5 per-project session additions are all optional.
 */
function upgradeV2ToV5(v2: PersistedStateV2): PersistedState {
  return {
    schemaVersion: 5,
    lastProjectId: v2.lastProjectId,
    recents: v2.recents,
    projects: v2.projects,
    layout: { ...DEFAULT_LAYOUT },
    enabledPlugins: {},
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
