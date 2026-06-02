/**
 * Persisted-state migrator.
 *
 * `workspace.json` is the only file we persist. After REQ-005 the schema is
 * v3: same as v2 plus a workspace-level `layout` snapshot (the three
 * resizable IDE panel sizes).
 *
 * Policy:
 *
 *   1. Read raw JSON.
 *   2. If `schemaVersion === 3` → trust it, pass through.
 *   3. If `schemaVersion === 2` → shape-preserving upgrade: carry everything
 *      over and fill `layout` with defaults. No backup is written — v2 had
 *      shipped briefly and contains the user's real projects + tabs; we keep
 *      them.
 *   4. If `schemaVersion === 1` → archive the file as `workspace.v1.bak`
 *      and return fresh v3 defaults. There is no shape-preserving upgrade
 *      because the v1 "project = folder + auto-detected repos" model can't
 *      be mapped onto the v2+ "project = named container with user-added
 *      repos" model. Users had no real projects yet — this is the
 *      acceptable trade-off documented in the REQ-003 spec.
 *   5. Anything else (missing version, future version, garbled shape) →
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
    schemaVersion: 3,
    lastProjectId: null,
    recents: [],
    projects: {},
    layout: { ...DEFAULT_LAYOUT },
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
 *          looks like a valid v2 — `store.ts` relies on that to avoid an
 *          unnecessary write on every launch.
 */
export function migrate(raw: unknown, sourcePath?: string): PersistedState {
  if (isValidV3(raw)) {
    return raw;
  }
  // v2 → shape-preserving upgrade. v2 had real user data; carry it forward
  // and fill the new `layout` field with defaults. No backup needed.
  if (isValidV2(raw)) {
    return upgradeV2ToV3(raw);
  }
  // v1 → archive as workspace.v1.bak, return fresh v3 defaults.
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
 * Internal shape for a v2 payload — the previous schema. Used by the v2 → v3
 * shape-preserving upgrade path.
 */
interface PersistedStateV2 {
  schemaVersion: 2;
  lastProjectId: string | null;
  recents: PersistedState['recents'];
  projects: PersistedState['projects'];
  window: PersistedState['window'];
}

/**
 * Structural check for a v3 payload. We don't accept `schemaVersion === 3`
 * on its own — a file missing the rest of the top-level shape would crash
 * the renderer on first read, so we treat it as needing migration too.
 */
function isValidV3(raw: unknown): raw is PersistedState {
  if (!hasV2Shape(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 3) return false;

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
 * `layout`. v2 → v3 upgrade is shape-preserving.
 */
function isValidV2(raw: unknown): raw is PersistedStateV2 {
  if (!hasV2Shape(raw)) return false;
  const r = raw as Record<string, unknown>;
  return r.schemaVersion === 2;
}

/**
 * Shared structural check for the v2-and-up fields (`lastProjectId`,
 * `recents`, `projects`, `window`). Used by both v2 and v3 validators.
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
 * Shape-preserving upgrade from v2 → v3: copy every existing field, bump
 * the version marker, and add the new `layout` field with defaults.
 */
function upgradeV2ToV3(v2: PersistedStateV2): PersistedState {
  return {
    schemaVersion: 3,
    lastProjectId: v2.lastProjectId,
    recents: v2.recents,
    projects: v2.projects,
    layout: { ...DEFAULT_LAYOUT },
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
