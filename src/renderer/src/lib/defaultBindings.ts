/**
 * Default keybindings (E4-03).
 *
 * The shipped chord → command map. Loaded into the keybinding registry's
 * `default` layer at boot; the user layer (E4-04) overrides it. Chords use the
 * canonical form from `lib/keys.ts` (`mod` = Cmd on macOS, Ctrl elsewhere).
 *
 * Editor-scoped bindings (find, save, fold, …) are gated by `editorFocus` so
 * they only fire while the editor has focus and pass through otherwise.
 */

import type { Keybinding } from '../store/keybindingStore'

export const DEFAULT_KEYBINDINGS: ReadonlyArray<Omit<Keybinding, 'source'>> = [
  // ----- workbench chrome ---------------------------------------------
  { key: 'mod+k', command: 'workbench.action.quickOpen' },
  { key: 'mod+p', command: 'workbench.action.quickOpenFiles' },
  { key: 'mod+shift+p', command: 'workbench.action.showCommands' },
  { key: 'mod+j', command: 'workbench.action.togglePanel' },
  { key: 'mod+shift+n', command: 'workbench.action.newProject' },
  { key: 'mod+,', command: 'workbench.action.openSettings' },
  { key: 'mod+shift+e', command: 'workbench.view.explorer' },
  { key: 'mod+shift+g', command: 'workbench.view.scm' },
  { key: 'mod+shift+f', command: 'workbench.view.search' },
  { key: 'mod+shift+x', command: 'workbench.view.plugins' },
  { key: 'mod+w', command: 'workbench.action.closeActiveEditor' },
  { key: 'mod+shift+t', command: 'workbench.action.reopenClosedEditor' },
  { key: 'mod+\\', command: 'workbench.action.splitEditor' },
  { key: 'mod+1', command: 'workbench.action.focusFirstEditorGroup' },
  { key: 'mod+2', command: 'workbench.action.focusSecondEditorGroup' },

  // ----- editor (gated on editorFocus) --------------------------------
  { key: 'mod+f', command: 'editor.action.find', when: 'editorFocus' },
  { key: 'mod+alt+f', command: 'editor.action.replace', when: 'editorFocus' },
  { key: 'alt+z', command: 'editor.action.toggleWordWrap', when: 'editorFocus' },
  { key: 'mod+shift+o', command: 'editor.action.gotoSymbol', when: 'editorFocus' },
  { key: 'f2', command: 'editor.action.rename', when: 'editorFocus' },
  { key: 'f8', command: 'editor.action.marker.next', when: 'editorFocus' },
  { key: 'shift+f8', command: 'editor.action.marker.prev', when: 'editorFocus' },
  { key: 'mod+.', command: 'editor.action.quickFix', when: 'editorFocus' },
]
