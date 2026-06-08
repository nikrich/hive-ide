/**
 * Active editor registry tests (E1).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'

import { getActiveEditor, runEditorAction, setActiveEditor } from './activeEditor'

afterEach(() => setActiveEditor(null))

/** Minimal fake editor exposing getAction. */
function fakeEditor(actions: Record<string, () => void>): editor.IStandaloneCodeEditor {
  return {
    getAction: (id: string) => {
      const run = actions[id]
      return run ? { run: () => Promise.resolve(run()) } : null
    },
  } as unknown as editor.IStandaloneCodeEditor
}

describe('activeEditor', () => {
  it('stores and returns the active editor', () => {
    const ed = fakeEditor({})
    setActiveEditor(ed)
    expect(getActiveEditor()).toBe(ed)
  })

  it('runEditorAction triggers a known action and returns true', () => {
    const find = vi.fn()
    setActiveEditor(fakeEditor({ 'actions.find': find }))
    expect(runEditorAction('actions.find')).toBe(true)
    expect(find).toHaveBeenCalled()
  })

  it('runEditorAction returns false for an unknown action', () => {
    setActiveEditor(fakeEditor({}))
    expect(runEditorAction('nope')).toBe(false)
  })

  it('runEditorAction returns false when no editor is active', () => {
    setActiveEditor(null)
    expect(runEditorAction('actions.find')).toBe(false)
  })
})
