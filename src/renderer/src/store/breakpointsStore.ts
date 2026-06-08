/**
 * Breakpoints store (E3-03).
 *
 * Holds the set of breakpoint line numbers per file. The editor renders them
 * in the glyph margin and toggles them on gutter click; the DAP client (E3-01)
 * sends them to the adapter on launch / change. Kept renderer-side and
 * file-keyed so multiple editors (and a future debug session) read one source.
 */

import { create } from 'zustand'

export interface BreakpointsState {
  /** 1-based breakpoint line numbers keyed by absolute file path. */
  byFile: Record<string, number[]>
  /** Toggle a breakpoint at `line` in `file`. */
  toggle: (file: string, line: number) => void
  /** Replace all breakpoints for a file. */
  setForFile: (file: string, lines: number[]) => void
  /** Remove every breakpoint in a file. */
  clearFile: (file: string) => void
  /** Remove all breakpoints. */
  clearAll: () => void
  /** Lines for a file (sorted, possibly empty). */
  forFile: (file: string) => number[]
}

export const useBreakpointsStore = create<BreakpointsState>((set, get) => ({
  byFile: {},
  toggle: (file, line) =>
    set((s) => {
      const cur = s.byFile[file] ?? []
      const has = cur.includes(line)
      const next = has ? cur.filter((l) => l !== line) : [...cur, line].sort((a, b) => a - b)
      const byFile = { ...s.byFile }
      if (next.length === 0) delete byFile[file]
      else byFile[file] = next
      return { byFile }
    }),
  setForFile: (file, lines) =>
    set((s) => {
      const byFile = { ...s.byFile }
      if (lines.length === 0) delete byFile[file]
      else byFile[file] = [...lines].sort((a, b) => a - b)
      return { byFile }
    }),
  clearFile: (file) =>
    set((s) => {
      if (!(file in s.byFile)) return {}
      const byFile = { ...s.byFile }
      delete byFile[file]
      return { byFile }
    }),
  clearAll: () => set(() => ({ byFile: {} })),
  forFile: (file) => get().byFile[file] ?? [],
}))

/** Total breakpoint count across all files. */
export function totalBreakpoints(byFile: Record<string, number[]>): number {
  let n = 0
  for (const lines of Object.values(byFile)) n += lines.length
  return n
}
