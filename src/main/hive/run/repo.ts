/**
 * Resolve which repo a worker runs against (slice 2c). A story names a `team`;
 * the project's repos are the teams. Match by name; fall back to the first repo
 * so a stale/unknown team never wedges a run. Pure.
 */

import type { Repo } from '../../../types/workspace';

export function resolveRepoForStory(team: string, repos: readonly Repo[]): string | null {
  if (repos.length === 0) return null;
  const match = repos.find((r) => r.name === team);
  return (match ?? repos[0]).path;
}
