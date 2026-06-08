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
    // Guard the bridge: during a hot-reload the renderer can run ahead of a
    // stale preload that predates `window.hive.run`. Without this, accessing
    // `.onStatus` throws on mount and — with no error boundary above — blanks
    // the whole app. A missing bridge simply means "no runs available yet".
    const run = window.hive?.run
    if (!run) return
    const offStatus = run.onStatus((e) => {
      setActive(e.status === 'exited' ? null : e)
    })
    const offLog = run.onLog((e) => {
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
      if (!window.hive?.run) return
      setLogLines([])
      await window.hive.run.start(storyId)
    },
    stop: async () => {
      if (active && window.hive?.run) await window.hive.run.stop(active.runId)
    },
  }
}
