/**
 * Plugin storage tests — REQ-006.
 *
 * Covers id → folder mapping, plugins directory creation, and
 * `removeDir` idempotency.
 */

import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import mockFs from 'mock-fs';

import type { App } from 'electron';

import {
  folderNameFor,
  pluginDirFor,
  pluginsDir,
  pluginsDirSync,
  removeDir,
} from './storage';

const USER_DATA = '/Users/test/Library/Application Support/Hive IDE';

/**
 * Hand-rolled stub of just the subset of `App` our storage helpers
 * reach. Keeps the test off Electron's runtime.
 */
function fakeApp(userData: string): App {
  return {
    getPath: (name: string) => {
      if (name === 'userData') return userData;
      throw new Error(`fakeApp: unexpected getPath(${name})`);
    },
  } as unknown as App;
}

afterEach(() => {
  mockFs.restore();
});

describe('folderNameFor', () => {
  it('replaces a single slash with a dash', () => {
    expect(folderNameFor('hive-ide/example-hello')).toBe(
      'hive-ide-example-hello',
    );
  });

  it('leaves ids without slashes alone', () => {
    expect(folderNameFor('hive-ide-example')).toBe('hive-ide-example');
  });

  it('handles multiple slashes (defensive — id schema forbids it)', () => {
    expect(folderNameFor('a/b/c')).toBe('a-b-c');
  });
});

describe('pluginsDir', () => {
  it('creates the directory and returns its absolute path', async () => {
    mockFs({ [USER_DATA]: {} });
    const dir = await pluginsDir(fakeApp(USER_DATA));
    expect(dir).toBe(`${USER_DATA}/plugins`);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent when the directory already exists', async () => {
    mockFs({ [`${USER_DATA}/plugins`]: {} });
    const dir = await pluginsDir(fakeApp(USER_DATA));
    expect(dir).toBe(`${USER_DATA}/plugins`);
  });
});

describe('pluginsDirSync', () => {
  it('returns the path without touching the filesystem', () => {
    mockFs({});
    expect(pluginsDirSync(fakeApp(USER_DATA))).toBe(
      `${USER_DATA}/plugins`,
    );
  });
});

describe('pluginDirFor', () => {
  it('joins the plugins dir with the folder-safe id', () => {
    mockFs({});
    const dir = pluginDirFor(fakeApp(USER_DATA), 'hive-ide/example-hello');
    expect(dir).toBe(`${USER_DATA}/plugins/hive-ide-example-hello`);
  });
});

describe('removeDir', () => {
  it('recursively deletes the directory', async () => {
    mockFs({
      '/p': {
        nested: { 'file.txt': 'hi' },
        'top.txt': 'x',
      },
    });
    await removeDir('/p');
    await expect(fs.stat('/p')).rejects.toThrow();
  });

  it('is a no-op when the directory is already gone', async () => {
    mockFs({});
    await expect(removeDir('/nope')).resolves.toBeUndefined();
  });
});
