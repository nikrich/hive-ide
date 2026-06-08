/**
 * Breakpoints store (E3-03, E3-10).
 *
 * Holds breakpoints per file. A breakpoint is `{ line, condition?, hitCondition?,
 * logMessage? }` so the store backs both plain breakpoints (gutter click) and
 * conditional / hit-count / logpoint breakpoints (E3-10). The editor renders
 * them in the glyph margin; the DAP client sends them to the adapter as
 * `SourceBreakpoint`s on launch / change.
 */

import { create } from 'zustand'

export interface Breakpoint {
  /** 1-based line. */
  line: number
  /** Expression that must be truthy to break (E3-10). */
  condition?: string
  /** Hit-count expression, e.g. `>= 3` (E3-10). */
  hitCondition?: string
  /** Log message instead of breaking — a logpoint (E3-10). */
  logMessage?: string
}

export interface BreakpointsState {
  /** Breakpoints keyed by absolute file path, sorted by line. */
  byFile: Record<string, Breakpoint[]>
  /** Toggle a plain breakpoint at `line` (removes any kind at that line). */
  toggle: (file: string, line: number) => void
  /** Add or update a breakpoint's condition fields at `line`. */
  setBreakpoint: (file: string, bp: Breakpoint) => void
  /** Replace all breakpoints for a file. */
  setForFile: (file: string, bps: Breakpoint[]) => void
  clearFile: (file: string) => void
  clearAll: () => void
  forFile: (file: string) => Breakpoint[]
}

function sortByLine(bps: Breakpoint[]): Breakpoint[] {
  return [...bps].sort((a, b) => a.line - b.line)
}

export const useBreakpointsStore = create<BreakpointsState>((set, get) => ({
  byFile: {},
  toggle: (file, line) =>
    set((s) => {
      const cur = s.byFile[file] ?? []
      const has = cur.some((b) => b.line === line)
      const next = has
        ? cur.filter((b) => b.line !== line)
        : sortByLine([...cur, { line }])
      const byFile = { ...s.byFile }
      if (next.length === 0) delete byFile[file]
      else byFile[file] = next
      return { byFile }
    }),
  setBreakpoint: (file, bp) =>
    set((s) => {
      const cur = s.byFile[file] ?? []
      const next = sortByLine([...cur.filter((b) => b.line !== bp.line), bp])
      return { byFile: { ...s.byFile, [file]: next } }
    }),
  setForFile: (file, bps) =>
    set((s) => {
      const byFile = { ...s.byFile }
      if (bps.length === 0) delete byFile[file]
      else byFile[file] = sortByLine(bps)
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

/** Lines that have a breakpoint in a file (for editor decorations). */
export function breakpointLines(bps: Breakpoint[] | undefined): number[] {
  return (bps ?? []).map((b) => b.line)
}

/** Total breakpoint count across all files. */
export function totalBreakpoints(byFile: Record<string, Breakpoint[]>): number {
  let n = 0
  for (const bps of Object.values(byFile)) n += bps.length
  return n
}
