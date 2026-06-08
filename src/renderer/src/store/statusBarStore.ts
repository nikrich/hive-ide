/**
 * Status bar item registry (E11-01).
 *
 * Features contribute persistent status-bar entries through this store rather
 * than hard-coding them into the App shell. Each item declares an alignment
 * (left / right) and a priority (higher sorts toward the window's outer edge,
 * matching VSCode), plus either a declarative `{ text, icon, tooltip, command }`
 * payload or a `render` escape hatch for complex widgets (the branch switcher,
 * progress spinners, …).
 *
 * Visibility of the whole bar is governed by the `workbench.statusBar.visible`
 * setting, handled in the `StatusBar` component.
 */

import type { ReactNode } from 'react'
import { create } from 'zustand'

export type StatusAlignment = 'left' | 'right'

export interface StatusBarItem {
  /** Stable unique id. */
  id: string
  alignment: StatusAlignment
  /** Higher = nearer the outer edge of its side. */
  priority: number
  /** Declarative text label (ignored when `render` is supplied). */
  text?: string
  /** kebab-case lucide icon name shown before the text. */
  icon?: string
  /** Native tooltip. */
  tooltip?: string
  /** Command id executed on click (declarative items only). */
  command?: string
  /** Args forwarded to `command`. */
  commandArgs?: unknown[]
  /** Optional accent colour for the text/icon. */
  color?: string
  /** Full custom renderer — overrides the declarative fields. */
  render?: () => ReactNode
}

export interface StatusBarState {
  items: Record<string, StatusBarItem>
  /** Register (or replace) an item. Returns a disposer. */
  register: (item: StatusBarItem) => () => void
  unregister: (id: string) => void
  /** Update an existing item's fields (no-op for unknown id). */
  update: (id: string, patch: Partial<Omit<StatusBarItem, 'id'>>) => void
}

export const useStatusBarStore = create<StatusBarState>((set, get) => ({
  items: {},
  register: (item) => {
    set((s) => ({ items: { ...s.items, [item.id]: item } }))
    return () => get().unregister(item.id)
  },
  unregister: (id) =>
    set((s) => {
      if (!(id in s.items)) return {}
      const items = { ...s.items }
      delete items[id]
      return { items }
    }),
  update: (id, patch) =>
    set((s) => {
      const cur = s.items[id]
      if (cur === undefined) return {}
      return { items: { ...s.items, [id]: { ...cur, ...patch } } }
    }),
}))

/** Sort items for one side: higher priority toward the outer edge. */
export function sortedSide(
  items: Record<string, StatusBarItem>,
  alignment: StatusAlignment,
): StatusBarItem[] {
  return Object.values(items)
    .filter((i) => i.alignment === alignment)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
}

/** Imperative register for non-React call sites. */
export const statusBar = {
  register: (item: StatusBarItem): (() => void) =>
    useStatusBarStore.getState().register(item),
  update: (id: string, patch: Partial<Omit<StatusBarItem, 'id'>>): void =>
    useStatusBarStore.getState().update(id, patch),
}
