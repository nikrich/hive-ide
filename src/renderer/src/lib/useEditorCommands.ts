/**
 * Editor commands (E1).
 *
 * Registers the editor-surface commands into the registry, mapping each to a
 * built-in Monaco action on the focused editor (find, replace, rename,
 * go-to-symbol, fold, format, problem navigation) or to a settings toggle
 * (word wrap, minimap, sticky scroll).
 *
 * Commands are intentionally NOT gated on `editorFocus` so they stay visible
 * in the command palette even though opening the palette blurs the editor —
 * `runEditorAction` simply no-ops when no editor is around. The *keybindings*
 * (DEFAULT_KEYBINDINGS) carry the `editorFocus` when-clause instead, so chords
 * like ⌘F only fire while the editor has focus.
 */

import { useEffect } from 'react'

import { runEditorAction } from './activeEditor'
import { useCommandStore, type Command } from '../store/commandStore'
import { useSettingsStore } from '../store/settingsStore'
import type { Settings } from '../../../types/settings'

/** Flip a boolean setting. */
function toggleBool(key: keyof Settings): void {
  const s = useSettingsStore.getState()
  const cur = s.settings[key]
  if (typeof cur === 'boolean') s.set(key, !cur as never)
}

export function useEditorCommands(): void {
  const register = useCommandStore((s) => s.register)
  useEffect(() => {
    const action = (id: string) => () => {
      runEditorAction(id)
    }
    const defs: Command[] = [
      {
        id: 'editor.action.find',
        title: 'Find',
        category: 'Editor',
        handler: action('actions.find'),
      },
      {
        id: 'editor.action.replace',
        title: 'Replace',
        category: 'Editor',
        handler: action('editor.action.startFindReplaceAction'),
      },
      {
        id: 'editor.action.rename',
        title: 'Rename Symbol',
        category: 'Editor',
        handler: action('editor.action.rename'),
      },
      {
        id: 'editor.action.gotoSymbol',
        title: 'Go to Symbol in Editor…',
        category: 'Go',
        handler: action('editor.action.quickOutline'),
      },
      {
        id: 'editor.action.formatDocument',
        title: 'Format Document',
        category: 'Editor',
        handler: action('editor.action.formatDocument'),
      },
      {
        id: 'editor.action.quickFix',
        title: 'Quick Fix…',
        category: 'Editor',
        handler: action('editor.action.quickFix'),
      },
      {
        id: 'editor.action.organizeImports',
        title: 'Organize Imports',
        category: 'Editor',
        handler: action('editor.action.organizeImports'),
      },
      {
        id: 'editor.action.sourceAction',
        title: 'Source Action…',
        category: 'Editor',
        handler: action('editor.action.sourceAction'),
      },
      {
        id: 'editor.action.marker.next',
        title: 'Go to Next Problem',
        category: 'Go',
        handler: action('editor.action.marker.next'),
      },
      {
        id: 'editor.action.marker.prev',
        title: 'Go to Previous Problem',
        category: 'Go',
        handler: action('editor.action.marker.prev'),
      },
      {
        id: 'editor.foldAll',
        title: 'Fold All',
        category: 'Editor',
        handler: action('editor.foldAll'),
      },
      {
        id: 'editor.unfoldAll',
        title: 'Unfold All',
        category: 'Editor',
        handler: action('editor.unfoldAll'),
      },
      {
        id: 'editor.action.toggleWordWrap',
        title: 'Toggle Word Wrap',
        category: 'View',
        handler: () => {
          const s = useSettingsStore.getState()
          s.set('editor.wordWrap', s.settings['editor.wordWrap'] === 'off' ? 'on' : 'off')
        },
      },
      {
        id: 'editor.action.toggleMinimap',
        title: 'Toggle Minimap',
        category: 'View',
        handler: () => toggleBool('editor.minimap'),
      },
      {
        id: 'editor.action.toggleStickyScroll',
        title: 'Toggle Sticky Scroll',
        category: 'View',
        handler: () => toggleBool('editor.stickyScroll'),
      },
    ]
    const disposers = defs.map((d) => register(d))
    return () => disposers.forEach((dispose) => dispose())
  }, [register])
}
