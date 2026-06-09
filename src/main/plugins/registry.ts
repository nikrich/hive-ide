/**
 * Plugin marketplace registry (E10-01, E10-02).
 *
 * Per the design spec the registry is an "own index JSON": a single document
 * listing available plugins (id → name/description/repo/latest). This module
 * holds the pure parse + update-detection logic; the IPC handler fetches the
 * document over https and runs it through `parseRegistry`.
 */

import semver from 'semver';

/** One entry in the marketplace index. */
export interface RegistryPlugin {
  id: string;
  name: string;
  description?: string;
  publisher?: string;
  /** GitHub source used by the existing install-from-release path. */
  repo: { owner: string; repo: string; tag?: string };
  /** Latest published version (semver). */
  latest: string;
  readmeUrl?: string;
}

/** Validate + normalise an arbitrary fetched document into registry entries. */
export function parseRegistry(raw: unknown): RegistryPlugin[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const plugins = (raw as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) return [];
  const out: RegistryPlugin[] = [];
  for (const p of plugins) {
    if (typeof p !== 'object' || p === null) continue;
    const e = p as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.name !== 'string') continue;
    const repo = e.repo as Record<string, unknown> | undefined;
    if (
      typeof repo !== 'object' ||
      repo === null ||
      typeof repo.owner !== 'string' ||
      typeof repo.repo !== 'string'
    ) {
      continue;
    }
    out.push({
      id: e.id,
      name: e.name,
      description: typeof e.description === 'string' ? e.description : undefined,
      publisher: typeof e.publisher === 'string' ? e.publisher : undefined,
      repo: {
        owner: repo.owner,
        repo: repo.repo,
        tag: typeof repo.tag === 'string' ? repo.tag : undefined,
      },
      latest: typeof e.latest === 'string' ? e.latest : '0.0.0',
      readmeUrl: typeof e.readmeUrl === 'string' ? e.readmeUrl : undefined,
    });
  }
  return out;
}

/**
 * True when `latest` is a newer semver than `installed` (E10-02). Invalid
 * versions are treated as "no update" rather than throwing.
 */
export function isUpdateAvailable(installed: string, latest: string): boolean {
  const a = semver.coerce(installed);
  const b = semver.coerce(latest);
  if (a === null || b === null) return false;
  return semver.gt(b, a);
}
