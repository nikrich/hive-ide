/**
 * Live hive-session state for the renderer + the subscription hook.
 *
 * A tiny zustand store holds `{ connection, snapshot, events }`. `useHiveSession`
 * (called once in the app shell) subscribes to the preload pushes and re-points
 * the reader whenever the active project's `hiveWorkspacePath` changes — the
 * same store-driven pattern as `useProjectWatchers`.
 */
import { useEffect } from 'react'
import { create } from 'zustand'

import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  HiveChatMessage,
  HiveConnection,
  HiveEvent,
  HiveSnapshot,
} from '../../../types/hive'

const EMPTY_SNAPSHOT: HiveSnapshot = { requirements: [], stories: [], agents: [] }
const MAX_TAIL = 500

interface HiveSessionState {
  connection: HiveConnection
  snapshot: HiveSnapshot
  events: HiveEvent[]
  chat: HiveChatMessage[]
  setConnection: (c: HiveConnection) => void
  setSnapshot: (s: HiveSnapshot) => void
  appendEvents: (e: HiveEvent[]) => void
  appendChat: (m: HiveChatMessage[]) => void
  reset: (
    c: HiveConnection,
    s: HiveSnapshot,
    e: HiveEvent[],
    chat: HiveChatMessage[],
  ) => void
}

export const useHiveSessionStore = create<HiveSessionState>((set) => ({
  connection: { state: 'no-workspace' },
  snapshot: EMPTY_SNAPSHOT,
  events: [],
  chat: [],
  setConnection: (connection) => set({ connection }),
  setSnapshot: (snapshot) => set({ snapshot }),
  appendEvents: (e) =>
    set((s) => ({ events: [...s.events, ...e].slice(-MAX_TAIL) })),
  appendChat: (m) =>
    set((s) => ({ chat: [...s.chat, ...m].slice(-MAX_TAIL) })),
  reset: (connection, snapshot, events, chat) =>
    set({ connection, snapshot, events, chat }),
}))

/** Subscribe to hive pushes + re-point on project workspace change. */
export function useHiveSession(): void {
  const hiveWorkspacePath = useWorkspaceStore(
    (s) => s.project?.hiveWorkspacePath ?? null,
  )

  // Establish the three subscriptions once.
  useEffect(() => {
    const bridge = window.hive?.orchestration
    if (!bridge) return
    const store = useHiveSessionStore.getState()
    const unsubs = [
      bridge.onSnapshot((snap) => store.setSnapshot(snap)),
      bridge.onEvents((evs) => store.appendEvents(evs)),
      bridge.onConnection((conn) => store.setConnection(conn)),
      bridge.onChat((m) => store.appendChat(m)),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // Re-point the reader whenever the active project's workspace path changes.
  useEffect(() => {
    const bridge = window.hive?.orchestration
    if (!bridge) return
    let cancelled = false
    void bridge
      .setWorkspace(hiveWorkspacePath)
      .then((bundle) => {
        if (cancelled) return
        useHiveSessionStore
          .getState()
          .reset(bundle.connection, bundle.snapshot, bundle.events, bundle.chat)
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('useHiveSession: setWorkspace failed', e)
      })
    return () => {
      cancelled = true
    }
  }, [hiveWorkspacePath])
}
