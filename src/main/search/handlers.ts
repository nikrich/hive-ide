/**
 * Search IPC handlers (E2-01).
 *
 * Exposes content search + a quick-open file listing over IPC. Roots are
 * re-validated at the trust boundary (same rule as the fs handlers) before the
 * engine walks them.
 */

import { ipcMain } from 'electron'

import { validatePath } from '../fs/validate-path'
import {
  listFiles,
  searchFiles,
  type ListFilesRequest,
  type SearchRequest,
  type SearchResponse,
} from './engine'

export const SEARCH_FILES_CHANNEL = 'search:files'
export const SEARCH_LIST_FILES_CHANNEL = 'search:list-files'

function validateRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) throw new TypeError('search: roots must be an array')
  return roots.map((r) => validatePath(String(r)))
}

/** Register `search:*` handlers. Returns a teardown. */
export function registerSearchHandlers(): () => void {
  ipcMain.handle(
    SEARCH_FILES_CHANNEL,
    (_e, req: SearchRequest): Promise<SearchResponse> =>
      searchFiles({ ...req, roots: validateRoots(req.roots) }),
  )
  ipcMain.handle(
    SEARCH_LIST_FILES_CHANNEL,
    (_e, req: ListFilesRequest) =>
      listFiles({ ...req, roots: validateRoots(req.roots) }),
  )
  return () => {
    ipcMain.removeHandler(SEARCH_FILES_CHANNEL)
    ipcMain.removeHandler(SEARCH_LIST_FILES_CHANNEL)
  }
}
