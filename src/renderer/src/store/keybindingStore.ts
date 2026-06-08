/**
 * Keybinding registry (E4-03).
 *
 * Maps canonical chord strings (see `lib/keys.ts`) to command ids, optionally
 * gated by a when-clause. Holds two layers — `default` (shipped) and `user`
 * (customised via the keybindings editor, E4-04) — so a user binding can
 * override or disable a default one.
 *
 * `resolve` picks the winning binding for a chord under the current context:
 * user bindings beat defaults, and within a layer the last-registered wins.
 * A binding whose command is the empty string acts as an "unbind" (lets the
 * user disable a default chord).
 */

import { create } from 'zustand'

import { evaluateWhen, type WhenContext } from '../lib/when'

export interface Keybinding {
  /** Canonical chord, e.g. `'mod+shift+p'`. */
  key: string
  /** Command id to run. Empty string disables the chord (an unbind). */
  command: string
  /** Optional when-clause gating applicability. */
  when?: string
  /** Which layer this binding came from. */
  source: 'default' | 'user'
  /** Optional args forwarded to the command. */
  args?: unknown[]
}

export interface KeybindingState {
  defaults: Keybinding[]
  user: Keybinding[]
  /** Replace the default layer (called once at boot). */
  setDefaults: (bindings: Keybinding[]) => void
  /** Replace the user layer (called by the keybindings editor / boot). */
  setUser: (bindings: Keybinding[]) => void
  /** All bindings (defaults then user). */
  all: () => Keybinding[]
}

export const useKeybindingStore = create<KeybindingState>((set, get) => ({
  defaults: [],
  user: [],
  setDefaults: (bindings) =>
    set(() => ({ defaults: bindings.map((b) => ({ ...b, source: 'default' as const })) })),
  setUser: (bindings) =>
    set(() => ({ user: bindings.map((b) => ({ ...b, source: 'user' as const })) })),
  all: () => [...get().defaults, ...get().user],
}))

/**
 * Resolve a chord to the command that should run under `context`, or `null`
 * when nothing applicable is bound (or the chord is explicitly unbound).
 * User layer wins over defaults; last match within the combined list wins.
 */
export function resolveChord(
  chord: string,
  context: WhenContext,
  bindings: Keybinding[],
): Keybinding | null {
  let winner: Keybinding | null = null
  for (const b of bindings) {
    if (b.key !== chord) continue
    if (!evaluateWhen(b.when, context)) continue
    // user beats default; otherwise later-in-list beats earlier.
    if (
      winner === null ||
      (b.source === 'user' && winner.source === 'default') ||
      b.source === winner.source
    ) {
      winner = b
    }
  }
  if (winner === null) return null
  // An empty command id is an explicit unbind.
  return winner.command === '' ? null : winner
}
