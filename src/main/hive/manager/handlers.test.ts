import { describe, it, expect, vi, beforeEach } from 'vitest';

const handle = vi.fn();
const removeHandler = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle: (...a: unknown[]) => handle(...a), removeHandler: (...a: unknown[]) => removeHandler(...a) } }));

import {
  HIVE_MANAGER_CHANNELS,
  HIVE_MANAGER_EVENTS,
  registerHiveManagerHandlers,
} from './handlers';
import type { IndexStatus } from '../../../types/hive';

beforeEach(() => {
  handle.mockClear();
  removeHandler.mockClear();
});

describe('registerHiveManagerHandlers', () => {
  it('registers a handler for every manager channel', () => {
    registerHiveManagerHandlers({ reindex: vi.fn(async () => {}), indexStatus: vi.fn(async () => ({})) });
    const registered = handle.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(expect.arrayContaining(Object.values(HIVE_MANAGER_CHANNELS)));
  });

  it('reindex handler forwards the repo arg', async () => {
    const reindex = vi.fn(async () => {});
    registerHiveManagerHandlers({ reindex, indexStatus: vi.fn(async () => ({})) });
    const call = handle.mock.calls.find((c) => c[0] === HIVE_MANAGER_CHANNELS.reindex)!;
    await (call[1] as (e: unknown, a: { repo: string }) => Promise<void>)({}, { repo: 'bff-web' });
    expect(reindex).toHaveBeenCalledWith('bff-web');
  });

  it('indexStatus handler returns the status map', async () => {
    const map: Record<string, IndexStatus> = { 'bff-web': 'indexed' };
    registerHiveManagerHandlers({ reindex: vi.fn(async () => {}), indexStatus: vi.fn(async () => map) });
    const call = handle.mock.calls.find((c) => c[0] === HIVE_MANAGER_CHANNELS.indexStatus)!;
    expect(await (call[1] as () => Promise<unknown>)()).toEqual(map);
  });

  it('teardown removes every channel', () => {
    const teardown = registerHiveManagerHandlers({ reindex: vi.fn(async () => {}), indexStatus: vi.fn(async () => ({})) });
    teardown();
    const removed = removeHandler.mock.calls.map((c) => c[0]);
    expect(removed).toEqual(expect.arrayContaining(Object.values(HIVE_MANAGER_CHANNELS)));
  });

  it('exposes the status push-event channel name', () => {
    expect(HIVE_MANAGER_EVENTS.status).toBe('event:hive:manager:status');
  });
});
