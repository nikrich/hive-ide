/**
 * Folder inspection — given an absolute folder path, return the bare
 * facts the renderer needs to add it to a project as a repo.
 *
 * Pure function over the filesystem: no IPC, no electron, no globals.
 * The IPC wrapper that exposes this to the renderer lives in
 * `src/main/project/handlers.ts`.
 *
 * REQ-003 replaced the multi-rule project-detection logic with this
 * single-responsibility helper. Projects are now user-created named
 * containers; folders are added to them one at a time, and all we need
 * at add-time is the folder's basename plus whether it's a git repo.
 */

import { promises as fs } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { InspectedFolder } from '../../types/workspace';

/**
 * Inspect the folder at `folderPath` and return its name + git status.
 *
 * @param folderPath Absolute path to the folder the user picked.
 * @returns The inspected folder shape — `{ path, name, isGitRepo }`.
 * @throws If `folderPath` cannot be read (e.g. doesn't exist, no permission).
 */
export async function inspectFolder(folderPath: string): Promise<InspectedFolder> {
  const path = resolve(folderPath);
  const name = basename(path);
  const isGitRepo = await pathExists(resolve(path, '.git'));
  return { path, name, isGitRepo };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Existence check that swallows only `ENOENT` / `ENOTDIR`.
 *
 * Everything else (permission denied, IO error, ...) propagates — we'd
 * rather surface a real problem than silently misreport "no .git/".
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
