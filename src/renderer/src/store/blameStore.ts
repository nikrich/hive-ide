/**
 * Git blame store (E7-08).
 *
 * Tracks which files have inline blame annotations enabled and caches the
 * per-line attribution fetched from the git backend. The editor renders the
 * lines as trailing injected text when a file is enabled.
 */

import { create } from 'zustand'

import type { GitBlameLine } from '../../../types/workspace'

export interface BlameState {
  /** Absolute paths with blame annotations showing. */
  enabled: Set<string>
  /** Cached blame lines keyed by absolute file path. */
  byFile: Record<string, GitBlameLine[]>
  setBlame: (file: string, lines: GitBlameLine[]) => void
  enable: (file: string) => void
  disable: (file: string) => void
  isEnabled: (file: string) => boolean
}

export const useBlameStore = create<BlameState>((set, get) => ({
  enabled: new Set<string>(),
  byFile: {},
  setBlame: (file, lines) =>
    set((s) => ({ byFile: { ...s.byFile, [file]: lines } })),
  enable: (file) =>
    set((s) => {
      const enabled = new Set(s.enabled)
      enabled.add(file)
      return { enabled }
    }),
  disable: (file) =>
    set((s) => {
      if (!s.enabled.has(file)) return {}
      const enabled = new Set(s.enabled)
      enabled.delete(file)
      return { enabled }
    }),
  isEnabled: (file) => get().enabled.has(file),
}))
