/**
 * Manager-lane IPC (slice 2b-2a) — reindex + index-status request/response and
 * the manager-status push-event channel. Mirrors `registerHiveLoopHandlers`:
 * ipcMain.handle per channel; teardown removes them all.
 */

import { ipcMain } from 'electron';

import type { IndexStatus, NewRequirementFields } from '../../../types/hive';

export const HIVE_MANAGER_CHANNELS = {
  reindex: 'ipc:hive:repo:reindex',
  indexStatus: 'ipc:hive:index:status',
  createRequirement: 'ipc:hive:requirement:create',
  approve: 'ipc:hive:requirement:approve',
  discard: 'ipc:hive:requirement:discard',
} as const;

export const HIVE_MANAGER_EVENTS = {
  status: 'event:hive:manager:status',
} as const;

export interface ManagerDeps {
  /** Enqueue an index job for one repo. */
  reindex: (repo: string) => Promise<void>;
  /** Current per-repo index status for the active workspace. */
  indexStatus: () => Promise<Record<string, IndexStatus>>;
  /** Write the requirement file then enqueue a decompose job. Returns the id. */
  createRequirement: (fields: NewRequirementFields) => Promise<string>;
  approve: (reqId: string) => Promise<void>;
  discard: (reqId: string) => Promise<void>;
}

export function registerHiveManagerHandlers(deps: ManagerDeps): () => void {
  ipcMain.handle(HIVE_MANAGER_CHANNELS.reindex, (_e, args: { repo: string }) =>
    deps.reindex(args.repo),
  );
  ipcMain.handle(HIVE_MANAGER_CHANNELS.indexStatus, () => deps.indexStatus());
  ipcMain.handle(HIVE_MANAGER_CHANNELS.createRequirement, (_e, fields: NewRequirementFields) =>
    deps.createRequirement(fields),
  );
  ipcMain.handle(HIVE_MANAGER_CHANNELS.approve, (_e, args: { reqId: string }) =>
    deps.approve(args.reqId),
  );
  ipcMain.handle(HIVE_MANAGER_CHANNELS.discard, (_e, args: { reqId: string }) =>
    deps.discard(args.reqId),
  );
  return () => {
    for (const c of Object.values(HIVE_MANAGER_CHANNELS)) ipcMain.removeHandler(c);
  };
}
