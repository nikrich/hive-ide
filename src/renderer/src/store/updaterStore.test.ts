// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdaterStatus, UpdaterStatusHandler } from '../../../preload/api';
import { useUpdaterStore } from './updaterStore';
import { useNotificationsStore } from './notificationsStore';

let statusHandler: UpdaterStatusHandler | null = null;
const check = vi.fn(() => Promise.resolve());
const quitAndInstall = vi.fn(() => Promise.resolve());

beforeEach(() => {
  statusHandler = null;
  check.mockClear();
  quitAndInstall.mockClear();
  useNotificationsStore.setState({ items: [], unread: 0 });
  useUpdaterStore.setState({
    status: { phase: 'idle' },
    version: '',
  });
  (window as unknown as { hive: unknown }).hive = {
    updater: {
      check,
      quitAndInstall,
      getVersion: () => Promise.resolve('3.1.4'),
      onStatus: (h: UpdaterStatusHandler) => {
        statusHandler = h;
        return () => {
          statusHandler = null;
        };
      },
    },
  };
});

afterEach(() => {
  delete (window as unknown as { hive?: unknown }).hive;
});

function emit(status: UpdaterStatus): void {
  statusHandler?.(status);
}

describe('updaterStore', () => {
  it('init() loads the current version and subscribes to status', async () => {
    const unsub = useUpdaterStore.getState().init();
    await Promise.resolve();
    await Promise.resolve();
    expect(useUpdaterStore.getState().version).toBe('3.1.4');
    expect(typeof statusHandler).toBe('function');
    unsub();
    expect(statusHandler).toBeNull();
  });

  it('stores the latest pushed status', () => {
    useUpdaterStore.getState().init();
    emit({ phase: 'downloading', percent: 30 });
    expect(useUpdaterStore.getState().status).toEqual({ phase: 'downloading', percent: 30 });
  });

  it('posts a Restart action toast when an update is downloaded', () => {
    useUpdaterStore.getState().init();
    emit({ phase: 'downloaded', version: '3.2.0' });
    const items = useNotificationsStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].message).toContain('3.2.0');
    expect(items[0].actions?.[0].label).toMatch(/restart/i);
    items[0].actions?.[0].run();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('checkForUpdates() calls the bridge and notifies up-to-date on not-available', () => {
    useUpdaterStore.setState({ version: '3.1.4' });
    useUpdaterStore.getState().init();
    useUpdaterStore.getState().checkForUpdates();
    expect(check).toHaveBeenCalledTimes(1);
    emit({ phase: 'not-available' });
    const msgs = useNotificationsStore.getState().items.map((i) => i.message);
    expect(msgs.some((m) => /up to date/i.test(m))).toBe(true);
  });

  it('a background not-available (no manual check) does NOT notify', () => {
    useUpdaterStore.getState().init();
    emit({ phase: 'not-available' });
    expect(useNotificationsStore.getState().items).toHaveLength(0);
  });

  it('notifies "packaged builds only" on unsupported after a manual check', () => {
    useUpdaterStore.getState().init();
    useUpdaterStore.getState().checkForUpdates();
    emit({ phase: 'unsupported' });
    const msgs = useNotificationsStore.getState().items.map((i) => i.message);
    expect(msgs.some((m) => /packaged/i.test(m))).toBe(true);
  });

  it('notifies the error message on error after a manual check', () => {
    useUpdaterStore.getState().init();
    useUpdaterStore.getState().checkForUpdates();
    emit({ phase: 'error', error: 'network timeout' });
    const msgs = useNotificationsStore.getState().items.map((i) => i.message);
    expect(msgs.some((m) => m.includes('network timeout'))).toBe(true);
  });
});
