/**
 * Background-task progress registry (E11-08).
 *
 * Long-running operations (search, git ops, LSP indexing, hive runs) register a
 * task here; the status bar shows a spinner + the most-recent label while any
 * task is active. Tasks are keyed so a feature can start/end its own without
 * tracking ids elsewhere.
 */

import { create } from 'zustand'

export interface ProgressTask {
  id: string
  label: string
  /** Monotonic order so the status bar shows the newest task. */
  seq: number
}

export interface ProgressState {
  tasks: Record<string, ProgressTask>
  start: (id: string, label: string) => void
  end: (id: string) => void
}

let seq = 0

export const useProgressStore = create<ProgressState>((set) => ({
  tasks: {},
  start: (id, label) =>
    set((s) => {
      seq += 1
      return { tasks: { ...s.tasks, [id]: { id, label, seq } } }
    }),
  end: (id) =>
    set((s) => {
      if (!(id in s.tasks)) return {}
      const tasks = { ...s.tasks }
      delete tasks[id]
      return { tasks }
    }),
}))

/** The newest active task, or null when idle. */
export function newestTask(
  tasks: Record<string, ProgressTask>,
): ProgressTask | null {
  let best: ProgressTask | null = null
  for (const t of Object.values(tasks)) {
    if (best === null || t.seq > best.seq) best = t
  }
  return best
}

/** Imperative wrappers for non-React call sites. */
export const progress = {
  start: (id: string, label: string): void =>
    useProgressStore.getState().start(id, label),
  end: (id: string): void => useProgressStore.getState().end(id),
}
