/**
 * LRU helper for the Welcome screen's "recent projects" list.
 *
 * Pure — no Zustand, no React, just functions. Consumed by the
 * `pushRecent` action in `workspaceStore.ts`.
 */

import type { RecentEntry } from '../../../types/workspace'

/** Maximum recents we keep on disk + in memory. */
export const RECENTS_MAX = 10

/**
 * Push a new entry onto the recents list.
 *
 * - The new entry goes to the front (most-recent first).
 * - Any existing entry with the same `id` is removed first (dedup).
 * - The list is capped at {@link RECENTS_MAX} — overflow drops off the tail.
 *
 * Returns a new array. The input is never mutated.
 */
export function pushRecent(
  list: readonly RecentEntry[],
  entry: RecentEntry,
): RecentEntry[] {
  const filtered = list.filter((r) => r.id !== entry.id)
  filtered.unshift(entry)
  if (filtered.length > RECENTS_MAX) filtered.length = RECENTS_MAX
  return filtered
}
