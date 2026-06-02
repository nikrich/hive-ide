/**
 * Persisted-state migrator — REQ-002 / STORY-019.
 *
 * `workspace.json` is the only file we persist. v1 is the only schema this
 * REQ ships, but the migrator has to be defensive from day one so the next
 * bump doesn't silently delete users' tab layouts.
 *
 * Policy (from the REQ-002 design doc):
 *
 *   1. Read raw JSON.
 *   2. If `schemaVersion === 1` → trust it, pass through.
 *   3. Else (missing version, future version, garbled shape) →
 *      copy the existing file to `workspace.v0.bak` *alongside* it,
 *      then return a fresh defaults block. Losing tabs is preferable
 *      to crashing on launch.
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

/** Filename written next to `workspace.json` when its schema is unknown. */
export const BACKUP_FILENAME = 'workspace.v0.bak';

/**
 * The shape of a freshly-installed workspace. Returned whenever the on-disk
 * file is missing, malformed, or from a future schema. Deep-cloned on every
 * call so callers can mutate the result without poisoning subsequent ones.
 */
export function defaults(): PersistedState {
  return {
    schemaVersion: 1,
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
 *          looks like a valid v1 — `store.ts` relies on that to avoid an
 *          unnecessary write on every launch.
 */
export function migrate(raw: unknown, sourcePath?: string): PersistedState {
  if (isValidV1(raw)) {
    return raw;
  }
  if (sourcePath !== undefined) {
    archiveExisting(sourcePath);
  }
  return defaults();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Structural check for a v1 payload. We don't accept "schemaVersion === 1"
 * on its own — a file missing the rest of the top-level shape would crash
 * the renderer on first read, so we treat it as needing migration too.
 */
function isValidV1(raw: unknown): raw is PersistedState {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;

  if (r.schemaVersion !== 1) return false;

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
 * Copy the source file to `workspace.v0.bak` in the same directory.
 *
 * Silent if the source file doesn't exist (fresh install — nothing to
 * archive). Errors are swallowed and logged: failing to back up an old
 * file is bad, but crashing the app on launch is worse.
 */
function archiveExisting(sourcePath: string): void {
  try {
    if (!existsSync(sourcePath)) return;
    const backupPath = join(dirname(sourcePath), BACKUP_FILENAME);
    copyFileSync(sourcePath, backupPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[state.migrate] failed to archive existing workspace file:', err);
  }
}
