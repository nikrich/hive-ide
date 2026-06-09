/**
 * Global keybinding dispatcher (E4-03).
 *
 * Attaches one window-level keydown listener that turns each event into a
 * canonical chord, resolves it against the keybinding registry under the live
 * context, and executes the bound command. This is the central replacement for
 * the scattered `window.addEventListener('keydown', …)` blocks that used to
 * live in App / Explorer / Terminal components.
 *
 * Safety rails:
 *   - Lone modifier presses produce no chord and are ignored.
 *   - A printable single key with NO modifiers is never intercepted, so typing
 *     in inputs / the editor is untouched. (Function keys like F2/F8 and any
 *     modified chord are eligible; their when-clauses do the real gating.)
 *   - Only a resolved binding calls `preventDefault` — unbound chords pass
 *     through to the focused widget (e.g. Monaco's own bindings).
 */

import { useEffect } from 'react'

import { chordFromEvent, type Platform } from './keys'
import { useCommandStore } from '../store/commandStore'
import { resolveChord, useKeybindingStore } from '../store/keybindingStore'

/** True when the key, on its own, would type a character. */
function isPrintableSingle(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  )
}

export function useGlobalKeybindings(platform: Platform): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isPrintableSingle(event)) return
      const chord = chordFromEvent(event, platform)
      if (chord === null) return

      const { defaults, contributed, user } = useKeybindingStore.getState()
      const commandStore = useCommandStore.getState()
      const match = resolveChord(chord, commandStore.context, [
        ...defaults,
        ...contributed,
        ...user,
      ])
      if (match === null) return

      // A binding whose command isn't registered yet stays inert: don't
      // swallow the chord, so the focused widget's own handler (e.g. Monaco's
      // built-in find) still fires. Bindings light up once their epic
      // registers the matching command.
      if (commandStore.commands[match.command] === undefined) return

      event.preventDefault()
      event.stopPropagation()
      commandStore.execute(match.command, ...(match.args ?? []))
    }

    // Capture phase so a binding can pre-empt a focused widget's own handler
    // when (and only when) something is actually bound to the chord.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [platform])
}
