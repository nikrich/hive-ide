/**
 * Notifications store (E11-09).
 *
 * A small toast/notification system any feature can post to via `notify`.
 * Each notification carries a severity, message, optional actions, and an
 * auto-dismiss hint. The Notifications component renders the live toasts plus
 * a history center; the title-bar bell shows the unread count.
 */

import { create } from 'zustand'

export type NotificationSeverity = 'info' | 'warning' | 'error'

export interface NotificationAction {
  label: string
  run: () => void
}

export interface Notification {
  id: string
  severity: NotificationSeverity
  message: string
  /** Optional action buttons rendered on the toast. */
  actions?: NotificationAction[]
  /** Monotonic counter used for ordering + as a stable key. */
  seq: number
  /** Whether the toast is still showing (vs. moved to history). */
  active: boolean
}

export interface NotificationsState {
  items: Notification[]
  /** Count of notifications the user hasn't seen in the center yet. */
  unread: number
  add: (
    n: Omit<Notification, 'id' | 'seq' | 'active'> &
      Partial<Pick<Notification, 'id'>>,
  ) => string
  /** Move a toast to history (stop showing it) without deleting it. */
  dismiss: (id: string) => void
  /** Remove a notification entirely. */
  remove: (id: string) => void
  /** Clear history + reset unread. */
  clear: () => void
  /** Mark all as read (called when the center opens). */
  markRead: () => void
}

let seq = 0

export const useNotificationsStore = create<NotificationsState>((set) => ({
  items: [],
  unread: 0,
  add: (n) => {
    seq += 1
    const id = n.id ?? `ntf-${seq}`
    const notification: Notification = {
      id,
      severity: n.severity,
      message: n.message,
      actions: n.actions,
      seq,
      active: true,
    }
    set((s) => ({
      items: [...s.items.filter((i) => i.id !== id), notification],
      unread: s.unread + 1,
    }))
    return id
  },
  dismiss: (id) =>
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? { ...i, active: false } : i)),
    })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set(() => ({ items: [], unread: 0 })),
  markRead: () => set(() => ({ unread: 0 })),
}))

/** Imperative poster for non-React call sites (search errors, git ops, …). */
export function notify(
  severity: NotificationSeverity,
  message: string,
  actions?: NotificationAction[],
): string {
  return useNotificationsStore.getState().add({ severity, message, actions })
}
