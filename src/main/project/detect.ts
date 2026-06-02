/**
 * Project detection — given an absolute folder path, decide whether it's a
 * hive workspace, an auto-detectable monorepo of git repos, a single git
 * repo, or empty.
 *
 * Pure function over the filesystem: no IPC, no electron, no globals.
 * The IPC wrapper that exposes this to the renderer lives in
 * `src/main/project/handlers.ts` (STORY-018).
 *
 * Defined by REQ-002 design doc, STORY-016.
 */

import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { Project, Repo } from '../../types/workspace';

/**
 * Detect what kind of project lives at `rootPath`.
 *
 * Applies the four detection rules from the REQ-002 design doc, in order:
 *
 *   1. `<root>/.hive/config.yaml` exists      → `source = 'hive'`
 *   2. else any direct child has `.git/`      → `source = 'auto-detected'`
 *   3. else `<root>/.git/` exists             → `source = 'single-repo'`
 *   4. else                                   → `source = 'empty'`
 *
 * The first matching rule wins; later rules are not evaluated.
 *
 * @param rootPath Absolute path to the folder the user opened.
 * @returns The detected {@link Project}.
 * @throws If `rootPath` cannot be read (e.g. doesn't exist, no permission).
 */
export async function detect(rootPath: string): Promise<Project> {
  const root = resolve(rootPath);
  const lastOpenedAt = Date.now();
  const id = sha1(root);
  const name = basename(root);

  // Rule 1 — .hive/config.yaml takes precedence.
  const hiveRepos = await tryDetectHive(root);
  if (hiveRepos !== null) {
    return { id, name, rootPath: root, source: 'hive', repos: hiveRepos, lastOpenedAt };
  }

  // Rule 2 — any direct child with .git/.
  const childRepos = await tryDetectChildGitRepos(root);
  if (childRepos.length > 0) {
    return { id, name, rootPath: root, source: 'auto-detected', repos: childRepos, lastOpenedAt };
  }

  // Rule 3 — root itself is a git repo.
  if (await pathExists(resolve(root, '.git'))) {
    const single: Repo = { name, path: root, isGitRepo: true };
    return { id, name, rootPath: root, source: 'single-repo', repos: [single], lastOpenedAt };
  }

  // Rule 4 — empty.
  return { id, name, rootPath: root, source: 'empty', repos: [], lastOpenedAt };
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

/** Minimal subset of `.hive/config.yaml` we care about for detection. */
interface HiveConfig {
  teams?: Array<{ name?: string; repo_path?: string }>;
}

/**
 * Try Rule 1 — `<root>/.hive/config.yaml`.
 *
 * Returns the repo list when the file exists *and* parses to a valid
 * object with a `teams` array. Returns `null` when the file is absent
 * so the caller knows to fall through. A malformed YAML file is treated
 * as a hard error and re-thrown — silently falling through would hide
 * configuration bugs from the user.
 */
async function tryDetectHive(root: string): Promise<Repo[] | null> {
  const configPath = resolve(root, '.hive', 'config.yaml');

  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }

  const parsed = parseYaml(raw) as HiveConfig | null | undefined;
  const teams = parsed?.teams ?? [];

  return Promise.all(
    teams
      .filter((t): t is { name?: string; repo_path: string } => typeof t?.repo_path === 'string')
      .map(async (team) => {
        const repoPath = resolve(root, team.repo_path);
        return {
          name: team.name ?? basename(repoPath),
          path: repoPath,
          isGitRepo: await pathExists(resolve(repoPath, '.git')),
        };
      }),
  );
}

/**
 * Try Rule 2 — direct children with `.git/`.
 *
 * Reads `<root>`, keeps directory entries whose `<child>/.git` exists,
 * sorts them alphabetically so the explorer order is deterministic.
 */
async function tryDetectChildGitRepos(root: string): Promise<Repo[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }

  const dirEntries = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

  const checks = await Promise.all(
    dirEntries.map(async (entry) => {
      const childPath = resolve(root, entry.name);
      const isGit = await pathExists(resolve(childPath, '.git'));
      return isGit ? { name: entry.name, path: childPath, isGitRepo: true } : null;
    }),
  );

  return checks.filter((r): r is Repo => r !== null);
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Existence check that swallows only `ENOENT` / `ENOTDIR`.
 *
 * Everything else (permission denied, IO error, ...) propagates — we'd
 * rather surface a real problem than silently misdetect an empty folder.
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
