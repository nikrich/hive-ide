/**
 * User keybinding persistence (E4-04).
 *
 * The user keybinding layer (rebinds + unbinds from the keybindings editor) is
 * persisted to localStorage so customisations survive restarts. Kept separate
 * from the typed settings store because keybindings are an open-ended array
 * rather than a fixed schema.
 */

import type { Keybinding } from '../store/keybindingStore'

const KEY = 'hive.keybindings.user'

/** Load the persisted user keybinding layer (empty when none/invalid). */
export function loadUserKeybindings(): Keybinding[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (b): b is Keybinding =>
          typeof b === 'object' &&
          b !== null &&
          typeof (b as Keybinding).key === 'string' &&
          typeof (b as Keybinding).command === 'string',
      )
      .map((b) => ({ ...b, source: 'user' as const }))
  } catch {
    return []
  }
}

/** Persist the user keybinding layer. */
export function saveUserKeybindings(bindings: Keybinding[]): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(
        bindings.map((b) => ({
          key: b.key,
          command: b.command,
          when: b.when,
          args: b.args,
        })),
      ),
    )
  } catch {
    // storage unavailable; non-fatal
  }
}
