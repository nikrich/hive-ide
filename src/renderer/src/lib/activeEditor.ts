/**
 * Active editor registry (E1).
 *
 * Holds a reference to the Monaco editor that currently has focus so command
 * handlers (find, replace, rename, fold, format, …) and the save path can act
 * on "the editor the user is looking at" without prop-threading the instance.
 *
 * MonacoEditor sets the reference on focus and clears it on disposal.
 */

import type { editor } from 'monaco-editor'

let active: editor.IStandaloneCodeEditor | null = null

export function setActiveEditor(ed: editor.IStandaloneCodeEditor | null): void {
  active = ed
}

export function getActiveEditor(): editor.IStandaloneCodeEditor | null {
  return active
}

/**
 * Run a built-in Monaco editor action on the active editor by id. No-op when
 * no editor is focused or the action isn't available for the current model.
 * Returns true when an action was found and triggered.
 */
export function runEditorAction(actionId: string): boolean {
  const ed = active
  if (ed === null) return false
  const action = ed.getAction(actionId)
  if (action === null || action === undefined) return false
  void action.run()
  return true
}
