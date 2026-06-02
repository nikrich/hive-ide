/**
 * Persisted-state migrator.
 *
 * `workspace.json` is the only file we persist. After REQ-003 the schema is
 * v2: projects are user-created named containers, not folder-detection
 * results.
 *
 * Policy:
 *
 *   1. Read raw JSON.
 *   2. If `schemaVersion === 2` → trust it, pass through.
 *   3. If `schemaVersion === 1` → archive the file as `workspace.v1.bak`
 *      and return fresh v2 defaults. There is no shape-preserving upgrade
 *      because the v1 "project = folder + auto-detected repos" model can't
 *      be mapped onto the v2 "project = named container with user-added
 *      repos" model. Users had no real projects yet — this is the
 *      acceptable trade-off documented in the REQ-003 spec.
 *   4. Anything else (missing version, future version, garbled shape) →
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

import type { PersistedState } from '../../types/workspace';

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
 * The shape of a freshly-installed workspace. Returned whenever the on-disk
 * file is missing, malformed, or from a previous schema. Deep-cloned on every
 * call so callers can mutate the result without poisoning subsequent ones.
 */
export function defaults(): PersistedState {
  return {
    schemaVersion: 2,
    lastProjectId: null,
    recents: [],
    projects: {},
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
  if (isValidV2(raw)) {
    return raw;
  }
  // v1 → archive as workspace.v1.bak, return fresh v2 defaults.
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
 * Structural check for a v2 payload. We don't accept `schemaVersion === 2`
 * on its own — a file missing the rest of the top-level shape would crash
 * the renderer on first read, so we treat it as needing migration too.
 */
function isValidV2(raw: unknown): raw is PersistedState {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;

  if (r.schemaVersion !== 2) return false;

  if (r.lastProjectId !== null && typeof r.lastProjectId !== 'string') return false;
  if (!Array.isArray(r.recents)) return false;
  if (r.projects === null || typeof r.projects !== 'object') return false;

  const win = r.window;
  if (win === null || typeof win !== 'object') return false;
  const w = win as Record<string, unknown>;
  if (typeof w.width !== 'number' || typeof w.height !== 'number') return false;

  return true;
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
