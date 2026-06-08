/**
 * Debug event subscription (E3).
 *
 * Mounted once near the app root: forwards adapter events pushed from main
 * (`window.hive.debug.onEvent`) into the debug store, and reveals the editor at
 * the stopped frame's location.
 */

import { useEffect } from 'react'

import { useDebugStore } from '../store/debugStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useBreakpointsStore } from '../store/breakpointsStore'

export function useDebugEvents(): void {
  const handleEvent = useDebugStore((s) => s.handleEvent)

  useEffect(() => {
    const bridge = window.hive?.debug
    if (!bridge) return
    const unsubscribe = bridge.onEvent((event) => {
      handleEvent(event)
    })
    return unsubscribe
  }, [handleEvent])

  // When the session stops on a frame, reveal it in the editor (E3-09).
  const topFrame = useDebugStore((s) => s.frames[0])
  const status = useDebugStore((s) => s.status)
  useEffect(() => {
    if (status !== 'stopped' || !topFrame?.path) return
    useWorkspaceStore.getState().revealInFile(topFrame.path, topFrame.line, topFrame.column)
  }, [status, topFrame])

  // Live-sync breakpoint changes to the adapter while a session is active
  // (E3-03). Resends each file's breakpoints when the set changes.
  const byFile = useBreakpointsStore((s) => s.byFile)
  useEffect(() => {
    if (status === 'inactive') return
    const bridge = window.hive?.debug
    if (!bridge) return
    for (const [file, bps] of Object.entries(byFile)) {
      void bridge.setBreakpoints(file, bps).catch(() => undefined)
    }
  }, [byFile, status])
}
