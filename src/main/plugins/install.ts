/**
 * Plugin install / uninstall — REQ-006.
 *
 * Two install paths:
 *
 *   - {@link installLocal}: copy a folder the user picked into the
 *     plugins directory.
 *   - {@link installFromGithub}: fetch a release tarball from
 *     `api.github.com`, extract it under the plugins directory, then
 *     load it.
 *
 * Both validate the manifest before declaring success, so a bad payload
 * never sits half-extracted in the plugins folder. On a validation
 * failure we *do* still return the load result (with `valid=false`) —
 * the caller (Plugins view) shows it so the user can decide whether to
 * uninstall.
 *
 * The GitHub flow is deliberately the minimal viable surface: pick the
 * first `.tar.gz` asset, fall back to the auto-generated `tarball_url`.
 * Zip assets are not supported in this REQ — a tarball is one extract
 * call, a zip would require an extra dependency. The error message tells
 * the user to publish a tarball.
 */

import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { extract as tarExtract } from 'tar';

import type { LoadedPlugin } from '../../types/workspace';
import { loadPlugin } from './loader';
import { folderNameFor, removeDir } from './storage';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GithubInstallOptions {
  owner: string;
  repo: string;
  /** Release tag. When omitted, the latest release is used. */
  tag?: string;
}

// ---------------------------------------------------------------------------
// Local install
// ---------------------------------------------------------------------------

/**
 * Copy a local folder containing a `plugin.json` into the plugins
 * directory and return the loaded plugin.
 *
 * `src` is the folder the user picked; `pluginsDir` is the resolved
 * workspace plugins root (from {@link import('./storage').pluginsDir}).
 * The destination subdirectory is derived from the manifest id so the
 * user can't accidentally collide two plugins by naming source folders
 * the same thing.
 *
 * If a plugin with the same id is already installed we overwrite it —
 * effectively an upgrade. The user gets the new version's manifest back.
 */
export async function installLocal(
  src: string,
  pluginsDir: string,
  hiveVersion: string,
): Promise<LoadedPlugin> {
  // Validate before touching the destination so we don't half-install a
  // folder that lacks a manifest.
  const probe = await loadPlugin(src, hiveVersion);
  if (probe === null) {
    throw new Error(
      `installLocal: ${src} does not contain a plugin.json — nothing to install`,
    );
  }

  const dest = join(pluginsDir, folderNameFor(probe.manifest.id));

  // Overwrite-install: nuke any existing folder for this id before copy.
  await removeDir(dest);
  await fs.mkdir(dest, { recursive: true });
  await copyTree(src, dest);

  // Re-load from the final location so callers get accurate `rootPath`.
  const loaded = await loadPlugin(dest, hiveVersion);
  if (loaded === null) {
    // Should be unreachable — we just copied a folder we already validated.
    throw new Error('installLocal: post-install load returned null');
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// GitHub install
// ---------------------------------------------------------------------------

/**
 * Resolve the release endpoint we should fetch for `opts`. `tag` selects
 * `/releases/tags/<tag>`, omitted selects `/releases/latest`.
 */
function releaseUrl(opts: GithubInstallOptions): string {
  const base = `https://api.github.com/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/releases`;
  return opts.tag !== undefined
    ? `${base}/tags/${encodeURIComponent(opts.tag)}`
    : `${base}/latest`;
}

/**
 * Subset of the GitHub Releases API response we read. Untyped extras are
 * preserved on the wire but ignored here.
 */
interface GithubReleaseResponse {
  tag_name?: string;
  tarball_url?: string;
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
    content_type?: string;
  }>;
}

/**
 * Download a release tarball from GitHub, extract it under `pluginsDir`,
 * and return the loaded plugin.
 *
 * The on-wire layout we accept (in priority order):
 *
 *   1. The first asset whose name ends in `.tar.gz` / `.tgz`.
 *   2. The auto-generated `tarball_url` (always present, but it produces
 *      a top-level wrapper directory we need to strip when extracting).
 *
 * `.zip` assets are not supported in this REQ.
 */
export async function installFromGithub(
  opts: GithubInstallOptions,
  pluginsDir: string,
  hiveVersion: string,
): Promise<LoadedPlugin> {
  const meta = await fetchReleaseMetadata(opts);

  const tarballAsset = meta.assets?.find((a) => {
    const name = typeof a.name === 'string' ? a.name.toLowerCase() : '';
    return name.endsWith('.tar.gz') || name.endsWith('.tgz');
  });

  let downloadUrl: string;
  let stripComponents: number;
  if (tarballAsset?.browser_download_url !== undefined) {
    downloadUrl = tarballAsset.browser_download_url;
    stripComponents = 0;
  } else if (typeof meta.tarball_url === 'string') {
    // GitHub's auto-generated tarball wraps the repo in a top-level
    // `<owner>-<repo>-<sha>/` directory; strip it so plugin.json lands
    // at the root of the extract dest.
    downloadUrl = meta.tarball_url;
    stripComponents = 1;
  } else {
    throw new Error(
      `installFromGithub: release ${opts.owner}/${opts.repo}@${meta.tag_name ?? 'latest'} has no tarball asset`,
    );
  }

  // Extract into a temporary staging directory so a failed download or
  // a malformed manifest doesn't leave a corrupted folder under the
  // canonical plugins root. We rename into place once everything checks
  // out.
  const stagingDir = await fs.mkdtemp(
    join(tmpdir(), 'hive-plugin-install-'),
  );
  try {
    await downloadAndExtractTarball(downloadUrl, stagingDir, stripComponents);

    const staged = await loadPlugin(stagingDir, hiveVersion);
    if (staged === null) {
      throw new Error(
        `installFromGithub: extracted release ${opts.owner}/${opts.repo} does not contain a plugin.json`,
      );
    }

    const dest = join(pluginsDir, folderNameFor(staged.manifest.id));
    await removeDir(dest);
    await fs.mkdir(dest, { recursive: true });
    await copyTree(stagingDir, dest);

    const loaded = await loadPlugin(dest, hiveVersion);
    if (loaded === null) {
      throw new Error('installFromGithub: post-install load returned null');
    }
    return loaded;
  } finally {
    // Best-effort staging cleanup; never let teardown bury the real
    // install error.
    try {
      await removeDir(stagingDir);
    } catch {
      // ignore
    }
  }
}

/**
 * Uninstall a plugin by its installed root folder. Idempotent (no error
 * when the folder is already gone) so callers can re-run safely.
 */
export async function uninstall(dir: string): Promise<void> {
  await removeDir(dir);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Fetch + parse a release metadata document from `api.github.com`.
 *
 * Sets the required `User-Agent` header (`api.github.com` rejects
 * requests without one) and asks for the v3 JSON media type. We don't
 * pass an auth token — REQ-006 only fetches public releases.
 */
async function fetchReleaseMetadata(
  opts: GithubInstallOptions,
): Promise<GithubReleaseResponse> {
  const url = releaseUrl(opts);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'hive-ide',
    },
  });
  if (!res.ok) {
    throw new Error(
      `installFromGithub: ${url} responded ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as GithubReleaseResponse;
}

/**
 * Stream `url` to a temp file, then untar it into `dest`. Two-step rather
 * than streaming through tar directly so a partial / corrupted download
 * doesn't half-populate the destination directory.
 */
async function downloadAndExtractTarball(
  url: string,
  dest: string,
  stripComponents: number,
): Promise<void> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'hive-ide',
    },
    redirect: 'follow',
  });
  if (!res.ok || res.body === null) {
    throw new Error(
      `installFromGithub: tarball download ${url} responded ${res.status} ${res.statusText}`,
    );
  }

  const tmpFile = join(
    tmpdir(),
    `hive-plugin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.tar.gz`,
  );
  await fs.mkdir(dirname(tmpFile), { recursive: true });

  try {
    // Cast: Node's `fetch` returns a Web `ReadableStream` body; tar wants
    // a Node `Readable`. `Readable.fromWeb` is the documented bridge.
    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(nodeStream, createWriteStream(tmpFile));

    await tarExtract({
      file: tmpFile,
      cwd: dest,
      strip: stripComponents,
    });
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // best-effort
    }
  }
}

/**
 * Recursively copy `src` → `dest`.
 *
 * Hand-rolled rather than `fs.cp` so it works under mock-fs in the unit
 * tests (mock-fs as of v5 still doesn't implement `fs.cp`). For our use
 * case — copying a plugin folder, typically a few hundred small files —
 * the throughput difference vs. native `fs.cp` is negligible.
 */
async function copyTree(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(src, entry.name);
    const destChild = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(srcChild, destChild);
    } else if (entry.isSymbolicLink()) {
      // Preserve symlinks rather than dereferencing — matches `fs.cp`.
      const link = await fs.readlink(srcChild);
      await fs.symlink(link, destChild);
    } else {
      await fs.copyFile(srcChild, destChild);
    }
  }
}
