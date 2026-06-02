/**
 * Plugin setup-downloads runner — REQ-007.
 *
 * Some language-server plugins (notably Java/jdtls) ship a launcher
 * script in the plugin tarball but expect the heavy server binary to be
 * fetched on first use. This module owns that one-time download +
 * extract step.
 *
 * Contract (driven from {@link runPluginSetup}):
 *
 *   - Each `setup.downloads[]` entry names a `url`, an `extractTo` path
 *     relative to the plugin folder, and (optionally) a `sha256` and an
 *     `archive` kind.
 *   - If `extractTo` already has any contents the step is skipped — runs
 *     are idempotent, which lets the renderer call `runSetup` every time
 *     it spins up a language server without measurable cost.
 *   - The archive is downloaded to a temp file, hash-verified (if a
 *     `sha256` was provided), then extracted into `extractTo`. A mismatch
 *     throws; the temp file is unlinked either way.
 *   - `extractTo` is path-checked to live inside the plugin folder. A
 *     manifest can't write to `/etc/passwd` or `../sibling-plugin/`.
 *
 * `tar.gz` extraction uses the existing `tar` dependency (already pulled
 * in by REQ-006's github installer). `zip` uses `adm-zip` — small,
 * synchronous, no native bits. `none` just renames the temp file to
 * `extractTo` verbatim, which is the right move when a plugin ships a
 * single-file binary release.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import AdmZip from 'adm-zip';
import { extract as tarExtract } from 'tar';

import type { LoadedPlugin, PluginSetupDownload } from '../../../types/workspace';

/** Hook a caller can pass to surface progress (e.g. to a toast). */
export type SetupProgress = (message: string) => void;

/**
 * Run every declared setup download for `plugin`. Idempotent — a step
 * whose `extractTo` already has contents is skipped.
 *
 * Throws on hash mismatch, http failure, archive corruption, or a path
 * that tries to escape the plugin root. Partial state is best-effort
 * cleaned up before the throw bubbles, so a retry can recover.
 */
export async function runPluginSetup(
  plugin: LoadedPlugin,
  onProgress?: SetupProgress,
): Promise<void> {
  if (!plugin.valid) return;
  const downloads = plugin.manifest.setup?.downloads;
  if (downloads === undefined || downloads.length === 0) return;

  for (const download of downloads) {
    await runOneDownload(plugin.rootPath, download, onProgress);
  }
}

/**
 * Run a single download step. Exported so the unit tests can exercise
 * idempotence + hash-mismatch behaviour without driving a whole plugin
 * manifest through.
 */
export async function runOneDownload(
  pluginRoot: string,
  download: PluginSetupDownload,
  onProgress?: SetupProgress,
  // Test seam — overridable so unit tests can inject a fake fetch.
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const dest = resolveInsidePlugin(pluginRoot, download.extractTo);

  // Idempotence check: if the target directory already has *any* entries
  // we assume the previous extract succeeded. We don't try to verify the
  // exact tree shape — that's the plugin's responsibility (it can ship a
  // wrapper script that probes for the binary it needs).
  if (await dirHasContents(dest)) return;

  onProgress?.(`Downloading ${download.url}`);

  const tmpFile = await downloadToTemp(download.url, fetchFn);
  try {
    if (download.sha256 !== undefined) {
      onProgress?.(`Verifying ${download.url}`);
      const actual = await sha256OfFile(tmpFile);
      if (actual !== download.sha256.toLowerCase()) {
        throw new Error(
          `runPluginSetup: sha256 mismatch for ${download.url} (expected ${download.sha256}, got ${actual})`,
        );
      }
    }

    onProgress?.(`Extracting to ${download.extractTo}`);
    await fs.mkdir(dest, { recursive: true });
    const kind = resolveArchiveKind(download);
    if (kind === 'tar.gz') {
      await tarExtract({ file: tmpFile, cwd: dest });
    } else if (kind === 'zip') {
      await extractZip(tmpFile, dest);
    } else {
      // 'none' — copy the file verbatim into extractTo with the URL's
      // basename. Plugins that use this know what filename to expect.
      const base = filenameFromUrl(download.url) ?? 'download.bin';
      await fs.copyFile(tmpFile, join(dest, base));
    }
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Resolve `relPath` relative to `pluginRoot` and refuse anything that
 * escapes via `..`. Matches the guard `readPluginAsset` uses for asset
 * reads.
 */
function resolveInsidePlugin(pluginRoot: string, relPath: string): string {
  if (relPath.includes('\0')) {
    throw new Error('runPluginSetup: extractTo contains null byte');
  }
  const absolute = resolve(pluginRoot, relPath);
  const guard = pluginRoot.endsWith(sep) ? pluginRoot : pluginRoot + sep;
  if (absolute !== pluginRoot && !absolute.startsWith(guard)) {
    throw new Error(
      `runPluginSetup: extractTo escapes plugin root: ${relPath}`,
    );
  }
  return absolute;
}

async function dirHasContents(path: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path);
    return entries.length > 0;
  } catch (err: unknown) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function downloadToTemp(
  url: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': 'hive-ide' },
    redirect: 'follow',
  });
  if (!res.ok || res.body === null) {
    throw new Error(
      `runPluginSetup: download ${url} responded ${res.status} ${res.statusText}`,
    );
  }
  const tmpFile = join(
    tmpdir(),
    `hive-plugin-setup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await fs.mkdir(dirname(tmpFile), { recursive: true });
  const nodeStream = Readable.fromWeb(
    res.body as Parameters<typeof Readable.fromWeb>[0],
  );
  await pipeline(nodeStream, createWriteStream(tmpFile));
  return tmpFile;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(path));
  return hash.digest('hex');
}

function resolveArchiveKind(
  download: PluginSetupDownload,
): 'tar.gz' | 'zip' | 'none' {
  if (download.archive !== undefined) return download.archive;
  const lower = download.url.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.zip')) return 'zip';
  // Unknown extension + no override — assume verbatim. Safer than picking
  // an extractor that will then mangle binary data.
  return 'none';
}

async function extractZip(file: string, dest: string): Promise<void> {
  // adm-zip is synchronous + buffers the whole archive in memory. Fine
  // for jdtls-sized downloads (~80 MB) on a developer machine; we'd
  // revisit if we ever ship a plugin with a ≥1 GB archive.
  const zip = new AdmZip(file);
  zip.extractAllTo(dest, /* overwrite */ true);
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const last = path.split('/').pop();
    if (last !== undefined && last.length > 0) return last;
    return undefined;
  } catch {
    return undefined;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
