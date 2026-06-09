import { useEffect, useState } from 'react'

import type { IndexStatus } from '../../../types/hive'

export interface ManagerStatusState {
  /** Per-repo index status, keyed by repo name. */
  status: Record<string, IndexStatus>
}

/**
 * Subscribe to manager-lane status pushes and the per-repo index-status map.
 * Refetches the map on every status event so the UI tracks the lane. Mirrors
 * `useHiveLoop`: guards the bridge, subscribes, cleans up on unmount.
 */
export function useManagerStatus(): ManagerStatusState & {
  reindex: (repo: string) => Promise<void>
} {
  const [status, setStatus] = useState<Record<string, IndexStatus>>({})

  useEffect(() => {
    const manager = window.hive?.manager
    const index = window.hive?.index
    if (!manager || !index) return
    const refresh = (): void => {
      void index.status().then(setStatus).catch(() => undefined)
    }
    refresh()
    const off = manager.onStatus(() => refresh())
    return () => { off() }
  }, [])

  return {
    status,
    reindex: async (repo) => {
      await window.hive?.repo?.reindex(repo)
      // Optimistically refresh; the status push will follow.
      const map = await window.hive?.index?.status().catch(() => undefined)
      if (map) setStatus(map)
    },
  }
}
