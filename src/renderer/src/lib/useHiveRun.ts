import { useEffect, useState } from 'react'

import type { HiveRunStatusEvent } from '../../../types/hive'

export interface HiveRunState {
  active: HiveRunStatusEvent | null
  logLines: string[]
}

/**
 * Subscribe to worker-run status + log streams. Returns the active run (if any)
 * and a bounded tail of rendered log lines. Single run at a time (slice 2a).
 */
export function useHiveRun(): HiveRunState & {
  start: (storyId: string) => Promise<void>
  stop: () => Promise<void>
} {
  const [active, setActive] = useState<HiveRunStatusEvent | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])

  useEffect(() => {
    const offStatus = window.hive.run.onStatus((e) => {
      setActive(e.status === 'exited' ? null : e)
    })
    const offLog = window.hive.run.onLog((e) => {
      setLogLines((prev) => [...prev.slice(-499), e.line])
    })
    return () => {
      offStatus()
      offLog()
    }
  }, [])

  return {
    active,
    logLines,
    start: async (storyId) => {
      setLogLines([])
      await window.hive.run.start(storyId)
    },
    stop: async () => {
      if (active) await window.hive.run.stop(active.runId)
    },
  }
}
