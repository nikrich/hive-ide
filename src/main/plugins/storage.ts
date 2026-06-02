/**
 * Plugin storage — REQ-006.
 *
 * Owns the on-disk layout of installed plugins. Every other plugin module
 * routes through this one for path resolution so the directory naming
 * convention (id → folder) lives in exactly one place.
 *
 * Layout (under Electron's `userData`):
 *
 *   <userData>/plugins/                ← {@link pluginsDir}
 *   <userData>/plugins/<id-folder>/    ← {@link pluginDirFor}
 *
 * `<id-folder>` is the plugin's manifest `id` with every `/` replaced by
 * `-`. The id is the user-visible identity (`hive-ide/example-hello`); the
 * folder is just a filesystem-friendly version of it. We never reverse the
 * mapping — discovery walks the directory and reads each plugin's manifest
 * for the canonical id instead.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { App } from 'electron';

/**
 * Return the workspace-wide plugins directory, creating it on demand.
 *
 * Idempotent: missing parents are created with `recursive: true`, an
 * existing directory is left untouched.
 */
export async function pluginsDir(app: App): Promise<string> {
  const dir = join(app.getPath('userData'), 'plugins');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Synchronous variant — used by code paths that already know the
 * directory exists (e.g. tests, or repeat lookups after `pluginsDir` has
 * been awaited at boot). Does **not** create the directory.
 */
export function pluginsDirSync(app: App): string {
  return join(app.getPath('userData'), 'plugins');
}

/**
 * Map a plugin id to its filesystem-friendly folder name.
 *
 * Replaces every `/` with `-` so `hive-ide/example-hello` lands on disk
 * at `<plugins-dir>/hive-ide-example-hello/`. Exported as its own helper
 * so install/uninstall and discovery agree on the same scheme.
 */
export function folderNameFor(id: string): string {
  return id.replaceAll('/', '-');
}

/**
 * Absolute path of the folder a given plugin lives in.
 */
export function pluginDirFor(app: App, id: string): string {
  return join(pluginsDirSync(app), folderNameFor(id));
}

/**
 * Recursively delete a directory. Swallows `ENOENT` so the operation is
 * idempotent — uninstalling something that's already gone is not an
 * error. Other errors propagate so the caller can surface them.
 */
export async function removeDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err: unknown) {
    if (isNotFound(err)) return;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
