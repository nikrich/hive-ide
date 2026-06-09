import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const handlers = new Map<string, (...a: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (...a: unknown[]) => unknown) => handlers.set(c, fn),
    removeHandler: (c: string) => handlers.delete(c),
    __invoke: (c: string, ...a: unknown[]) => handlers.get(c)?.({}, ...a),
    __has: (c: string) => handlers.has(c),
  },
}));

import { ipcMain } from 'electron';
import {
  HIVE_MANAGER_CHANNELS,
  HIVE_MANAGER_EVENTS,
  registerHiveManagerHandlers,
} from './handlers';
import type { IndexStatus } from '../../../types/hive';

const mm = ipcMain as unknown as {
  __invoke: (c: string, ...a: unknown[]) => unknown;
  __has: (c: string) => boolean;
};

beforeEach(() => {
  handlers.clear();
});

afterEach(() => vi.restoreAllMocks());

describe('registerHiveManagerHandlers', () => {
  it('registers a handler for every manager channel', () => {
    registerHiveManagerHandlers({
      reindex: vi.fn(async () => {}),
      indexStatus: vi.fn(async () => ({})),
      createRequirement: vi.fn(async () => 'REQ-1'),
      approve: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    });
    const registered = [...handlers.keys()];
    expect(registered).toEqual(expect.arrayContaining(Object.values(HIVE_MANAGER_CHANNELS)));
  });

  it('reindex handler forwards the repo arg', async () => {
    const reindex = vi.fn(async () => {});
    registerHiveManagerHandlers({
      reindex,
      indexStatus: vi.fn(async () => ({})),
      createRequirement: vi.fn(async () => 'REQ-1'),
      approve: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    });
    await mm.__invoke(HIVE_MANAGER_CHANNELS.reindex, { repo: 'bff-web' });
    expect(reindex).toHaveBeenCalledWith('bff-web');
  });

  it('indexStatus handler returns the status map', async () => {
    const map: Record<string, IndexStatus> = { 'bff-web': 'indexed' };
    registerHiveManagerHandlers({
      reindex: vi.fn(async () => {}),
      indexStatus: vi.fn(async () => map),
      createRequirement: vi.fn(async () => 'REQ-1'),
      approve: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    });
    expect(await mm.__invoke(HIVE_MANAGER_CHANNELS.indexStatus)).toEqual(map);
  });

  it('teardown removes every channel', () => {
    const teardown = registerHiveManagerHandlers({
      reindex: vi.fn(async () => {}),
      indexStatus: vi.fn(async () => ({})),
      createRequirement: vi.fn(async () => 'REQ-1'),
      approve: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    });
    teardown();
    const remaining = [...handlers.keys()];
    expect(remaining).not.toEqual(expect.arrayContaining(Object.values(HIVE_MANAGER_CHANNELS)));
  });

  it('exposes the status push-event channel name', () => {
    expect(HIVE_MANAGER_EVENTS.status).toBe('event:hive:manager:status');
  });
});

describe('manager handlers — requirement channels', () => {
  it('routes create/approve/discard to deps and tears down', async () => {
    const createRequirement = vi.fn(async () => 'REQ-1');
    const approve = vi.fn(async () => {});
    const discard = vi.fn(async () => {});
    const teardown = registerHiveManagerHandlers({
      createRequirement,
      approve,
      discard,
      // 2b-2a deps — stubs
      reindex: vi.fn(async () => {}),
      indexStatus: vi.fn(async () => ({})),
    } as never);

    expect(await mm.__invoke(HIVE_MANAGER_CHANNELS.createRequirement, { title: 'X', body: 'y' })).toBe('REQ-1');
    expect(createRequirement).toHaveBeenCalledWith({ title: 'X', body: 'y' });

    await mm.__invoke(HIVE_MANAGER_CHANNELS.approve, { reqId: 'REQ-1' });
    expect(approve).toHaveBeenCalledWith('REQ-1');

    await mm.__invoke(HIVE_MANAGER_CHANNELS.discard, { reqId: 'REQ-1' });
    expect(discard).toHaveBeenCalledWith('REQ-1');

    teardown();
    expect(mm.__has(HIVE_MANAGER_CHANNELS.createRequirement)).toBe(false);
  });
});
