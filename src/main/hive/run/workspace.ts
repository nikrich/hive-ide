/**
 * IDE-managed hive workspace bootstrap (slice 2c). A project's workspace lives
 * under app data at `<userData>/hive-workspaces/<projectId>/` and holds the
 * `.hive/` state tree + events log + worktrees. Pure-ish: takes `userDataPath`
 * so it's testable against a temp dir; the IPC layer passes
 * `app.getPath('userData')`.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Absolute path of a project's IDE-managed hive workspace. */
export function workspaceDirFor(userDataPath: string, projectId: string): string {
  return join(userDataPath, 'hive-workspaces', projectId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotently create the `.hive/` tree (state/{requirements,stories,agents}
 * + an empty events.ndjson) under the project's workspace dir. Never truncates
 * an existing events.ndjson. Returns the workspace dir.
 */
export async function ensureWorkspace(userDataPath: string, projectId: string): Promise<string> {
  const dir = workspaceDirFor(userDataPath, projectId);
  const stateRoot = join(dir, '.hive', 'state');
  for (const sub of ['requirements', 'stories', 'agents']) {
    await mkdir(join(stateRoot, sub), { recursive: true });
  }
  const eventsPath = join(dir, '.hive', 'events.ndjson');
  if (!(await exists(eventsPath))) {
    await writeFile(eventsPath, '', 'utf8');
  }
  return dir;
}
