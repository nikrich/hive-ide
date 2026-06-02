/**
 * Filesystem IPC handlers — the main-process trust boundary.
 *
 * The renderer is treated as untrusted: every absolute path that comes
 * in over IPC is fed through `validatePath()` before any `fs.*` /
 * `shell.*` call. The handlers themselves are deliberately thin wrappers
 * over `node:fs/promises` and Electron's `shell` module — the real
 * security work lives in `./validate-path.ts` and its test suite.
 *
 * Defined by REQ-002 design doc, STORY-017.
 *
 * Channel naming follows the convention set by STORY-015's preload
 * comment: every renderer-facing channel lives under the `ipc:hive:*`
 * namespace, so the slice name `fs:read-file` becomes the full channel
 * `ipc:hive:fs:read-file`. The slice names themselves match the spec's
 * `### IPC channels (ipc:hive:* namespace)` table verbatim, so the
 * preload bridge wired up in a later story can call them directly.
 *
 * Why each handler does what it does:
 *
 * - `read-file` reads as UTF-8 and reports `encoding: 'utf8'`. REQ-002 is
 *   a text editor; binary detection is deferred to a later REQ.
 * - `write-file` writes UTF-8 too — symmetric with `read-file`.
 * - `list-dir` uses `withFileTypes: true` so we get the directory /
 *   symlink classification for free, then `lstat`s each child for
 *   `mtime`. `lstat` (not `stat`) so a symlink's own mtime is reported,
 *   not the target's — matters when watching a symlinked file.
 * - `stat` reports both `stat` (size, mtime, ctime, isDir, isFile) and
 *   `lstat` (`isSymlink`) so callers don't have to make two round trips.
 * - `mkdir` is recursive — the renderer's "new folder" flow can create
 *   nested paths in one IPC call and is a no-op when the dir exists.
 * - `rename` validates both endpoints because either can be attacker-
 *   controlled.
 * - `trash` and `reveal-in-finder` use Electron's `shell` so they
 *   respect platform conventions (macOS Trash, Windows Recycle Bin,
 *   Linux freedesktop).
 * - `exists` swallows `ENOENT` / `ENOTDIR` (returns `false`) but
 *   re-throws other errors — a permission failure is not "doesn't
 *   exist", and the renderer needs to know.
 */

import { ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { DirEntry, Stat } from '../../types/workspace';
import { validatePath } from './validate-path';

/** Shape of `fs:read-file` responses. Mirrors `HiveFsBridge.readFile`'s return type in `src/preload/api.ts`. */
interface FileContents {
  contents: string;
  encoding: 'utf8' | 'binary';
}

/**
 * Slice names from the REQ-002 spec table. Kept as a const map so the
 * channel strings exist in exactly one place; tests + bridge wiring can
 * import this if they want to stay in sync.
 */
export const FS_CHANNELS = {
  readFile: 'ipc:hive:fs:read-file',
  writeFile: 'ipc:hive:fs:write-file',
  listDir: 'ipc:hive:fs:list-dir',
  stat: 'ipc:hive:fs:stat',
  mkdir: 'ipc:hive:fs:mkdir',
  rename: 'ipc:hive:fs:rename',
  trash: 'ipc:hive:fs:trash',
  revealInFinder: 'ipc:hive:fs:reveal-in-finder',
  exists: 'ipc:hive:fs:exists',
} as const;

/**
 * Register every `fs:*` IPC handler with the global `ipcMain` registry.
 *
 * Call this once during app bootstrap (STORY-020 wires it into
 * `src/main/index.ts`). Calling it more than once will throw, because
 * `ipcMain.handle` rejects duplicate registrations — that's deliberate;
 * it surfaces accidental double-wire bugs at boot.
 */
export function registerFsHandlers(): void {
  ipcMain.handle(
    FS_CHANNELS.readFile,
    async (_event, rawPath: string): Promise<FileContents> => {
      const path = validatePath(rawPath);
      const contents = await fs.readFile(path, 'utf8');
      return { contents, encoding: 'utf8' };
    },
  );

  ipcMain.handle(
    FS_CHANNELS.writeFile,
    async (_event, rawPath: string, contents: string): Promise<void> => {
      const path = validatePath(rawPath);
      if (typeof contents !== 'string') {
        throw new TypeError(
          `fs:write-file: expected string contents, got ${typeof contents}`,
        );
      }
      await fs.writeFile(path, contents, 'utf8');
    },
  );

  ipcMain.handle(
    FS_CHANNELS.listDir,
    async (_event, rawPath: string): Promise<DirEntry[]> => {
      const path = validatePath(rawPath);
      const dirents = await fs.readdir(path, { withFileTypes: true });
      return Promise.all(
        dirents.map(async (entry): Promise<DirEntry> => {
          const childPath = join(path, entry.name);
          // `lstat` so we report the symlink's own mtime, not the target's.
          const ls = await fs.lstat(childPath);
          return {
            name: entry.name,
            path: childPath,
            isDir: entry.isDirectory(),
            isSymlink: entry.isSymbolicLink(),
            mtime: ls.mtimeMs,
          };
        }),
      );
    },
  );

  ipcMain.handle(
    FS_CHANNELS.stat,
    async (_event, rawPath: string): Promise<Stat> => {
      const path = validatePath(rawPath);
      // `stat` follows symlinks (so size/mtime are the target's),
      // `lstat` does not (so we can report whether *this* node is a
      // symlink). Both are needed.
      const s = await fs.stat(path);
      const ls = await fs.lstat(path);
      return {
        isDir: s.isDirectory(),
        isFile: s.isFile(),
        isSymlink: ls.isSymbolicLink(),
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
      };
    },
  );

  ipcMain.handle(
    FS_CHANNELS.mkdir,
    async (_event, rawPath: string): Promise<void> => {
      const path = validatePath(rawPath);
      await fs.mkdir(path, { recursive: true });
    },
  );

  ipcMain.handle(
    FS_CHANNELS.rename,
    async (_event, rawFrom: string, rawTo: string): Promise<void> => {
      const from = validatePath(rawFrom);
      const to = validatePath(rawTo);
      await fs.rename(from, to);
    },
  );

  ipcMain.handle(
    FS_CHANNELS.trash,
    async (_event, rawPath: string): Promise<void> => {
      const path = validatePath(rawPath);
      await shell.trashItem(path);
    },
  );

  ipcMain.handle(
    FS_CHANNELS.revealInFinder,
    async (_event, rawPath: string): Promise<void> => {
      const path = validatePath(rawPath);
      // `showItemInFolder` is fire-and-forget (returns void synchronously).
      // We still validate the path so a malicious renderer can't ask
      // Finder to highlight `/etc/shadow\0/tmp/innocent`.
      shell.showItemInFolder(path);
    },
  );

  ipcMain.handle(
    FS_CHANNELS.exists,
    async (_event, rawPath: string): Promise<boolean> => {
      const path = validatePath(rawPath);
      try {
        await fs.stat(path);
        return true;
      } catch (err: unknown) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  );
}

/**
 * Recognise the two errno codes that mean "this path doesn't resolve to
 * anything" — distinguishing them from "you don't have permission" or
 * "the disk is on fire", both of which we want to propagate.
 */
function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
