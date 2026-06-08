/**
 * References panel store (E2-11).
 *
 * Holds the most recent "find all references" result + whether the panel is
 * shown. Populated by the find-references command; rendered by ReferencesView.
 */

import { create } from 'zustand'

import type { ReferenceHit } from '../lib/references'

export interface ReferencesState {
  open: boolean
  symbol: string
  hits: ReferenceHit[]
  show: (symbol: string, hits: ReferenceHit[]) => void
  close: () => void
}

export const useReferencesStore = create<ReferencesState>((set) => ({
  open: false,
  symbol: '',
  hits: [],
  show: (symbol, hits) => set(() => ({ open: true, symbol, hits })),
  close: () => set(() => ({ open: false })),
}))
