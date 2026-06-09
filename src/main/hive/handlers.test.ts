import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...a: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (...a: unknown[]) => unknown) => handlers.set(c, fn),
    removeHandler: (c: string) => handlers.delete(c),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: class {},
}));

import { HIVE_CHANNELS, registerHiveHandlers } from './handlers';
import { hiveReader } from './reader';

const invoke = (c: string, ...a: unknown[]): unknown => handlers.get(c)?.({}, ...a);

let ws: string;
let teardown: () => void;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'hive-handlers-'));
  teardown = registerHiveHandlers({ getMainWindow: () => null });
});

afterEach(async () => {
  await hiveReader.setWorkspace(null); // close any watcher before teardown
  teardown();
  handlers.clear();
  await rm(ws, { recursive: true, force: true });
});

describe('sendChat handler', () => {
  it('validates the text before the connection (TypeError even with no workspace)', async () => {
    await hiveReader.setWorkspace(null);
    await expect(invoke(HIVE_CHANNELS.sendChat, 42)).rejects.toThrow(/must be a string/i);
  });

  it('rejects in the not-found state (workspace path set, but no .hive) — not ENOENT', async () => {
    await hiveReader.setWorkspace(ws); // ws has no .hive → connection = not-found
    await expect(invoke(HIVE_CHANNELS.sendChat, 'hi')).rejects.toThrow(
      /no workspace connected/i,
    );
  });

  it('appends to chat.ndjson when connected', async () => {
    await mkdir(join(ws, '.hive'), { recursive: true });
    await hiveReader.setWorkspace(ws);
    await invoke(HIVE_CHANNELS.sendChat, 'hello');
    const raw = await readFile(join(ws, '.hive', 'chat.ndjson'), 'utf8');
    expect(JSON.parse(raw.trim())).toMatchObject({ who: 'you', txt: 'hello' });
  });
});
