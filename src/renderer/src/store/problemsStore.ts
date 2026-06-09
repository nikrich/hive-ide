/**
 * Problems / diagnostics store (E9-01).
 *
 * Aggregates LSP diagnostics across files into one place the Problems panel
 * (E9-01), the status-bar counts (E9-04 / E11-07), and per-file badges read
 * from. Diagnostics are keyed by absolute file path; the LSP client
 * (`lspClient.ts`) calls `setForFile` whenever a `publishDiagnostics`
 * notification arrives for a document.
 */

import { create } from 'zustand'

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface Diagnostic {
  /** Absolute file path. */
  file: string
  /** 1-based line. */
  line: number
  /** 1-based column. */
  column: number
  endLine?: number
  endColumn?: number
  severity: DiagnosticSeverity
  message: string
  /** Producing tool, e.g. 'ts', 'eslint'. */
  source?: string
  code?: string | number
}

export interface DiagnosticCounts {
  errors: number
  warnings: number
  infos: number
  hints: number
}

export interface ProblemsState {
  /** Diagnostics keyed by absolute file path. */
  byFile: Record<string, Diagnostic[]>
  /** Replace the diagnostics for one file (empty array clears it). */
  setForFile: (file: string, diagnostics: Diagnostic[]) => void
  /** Drop a file's diagnostics entirely (e.g. on close/delete). */
  clearFile: (file: string) => void
  /** Remove every diagnostic. */
  clearAll: () => void
}

export const useProblemsStore = create<ProblemsState>((set) => ({
  byFile: {},
  setForFile: (file, diagnostics) =>
    set((s) => {
      if (diagnostics.length === 0) {
        if (!(file in s.byFile)) return {}
        const byFile = { ...s.byFile }
        delete byFile[file]
        return { byFile }
      }
      return { byFile: { ...s.byFile, [file]: diagnostics } }
    }),
  clearFile: (file) =>
    set((s) => {
      if (!(file in s.byFile)) return {}
      const byFile = { ...s.byFile }
      delete byFile[file]
      return { byFile }
    }),
  clearAll: () => set(() => ({ byFile: {} })),
}))

/** Flatten all diagnostics into a single array (file-grouped order). */
export function allDiagnostics(
  byFile: Record<string, Diagnostic[]>,
): Diagnostic[] {
  return Object.values(byFile).flat()
}

/** Tally diagnostics by severity. */
export function countDiagnostics(
  byFile: Record<string, Diagnostic[]>,
): DiagnosticCounts {
  const counts: DiagnosticCounts = { errors: 0, warnings: 0, infos: 0, hints: 0 }
  for (const diags of Object.values(byFile)) {
    for (const d of diags) {
      if (d.severity === 'error') counts.errors++
      else if (d.severity === 'warning') counts.warnings++
      else if (d.severity === 'info') counts.infos++
      else counts.hints++
    }
  }
  return counts
}
