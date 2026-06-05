/**
 * Folder auto-drill rule for the explorer.
 *
 * When the user expands a folder, we keep drilling into it as long as it is a
 * "passthrough" folder — one whose only entry is a single subdirectory. This
 * collapses the click-per-level tedium of deep single-child chains (e.g. Java
 * package dirs `com/example/app/...`) into one expand: the tree opens until it
 * reaches a folder that actually holds a file, branches into multiple entries,
 * or is empty.
 *
 * The async walk lives in the Explorer (it needs `fs.listDir` + the store);
 * this module is the pure decision so it can be unit-tested in isolation.
 */

import type { DirEntry } from '../../../types/workspace'

/**
 * Given a folder's listing, return the path of the lone subdirectory to
 * continue drilling into, or `null` to stop.
 *
 * Stops (returns `null`) when the folder is empty, contains a file, or has
 * more than one entry — i.e. anything other than exactly one subdirectory.
 */
export function nextDrillTarget(entries: readonly DirEntry[]): string | null {
  if (entries.length !== 1) return null
  const only = entries[0]
  return only.isDir ? only.path : null
}
