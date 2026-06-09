/**
 * Monaco DiffEditor wrapper — REQ-008, editable working-tree side (E7-03).
 *
 * Mirrors {@link MonacoEditor}'s code-splitting strategy: the underlying
 * `@monaco-editor/react` module is lazy-loaded so a session that never opens a
 * diff doesn't pay Monaco's bundle cost.
 *
 * The original (HEAD/index) side is always read-only. When `onSaveModified` is
 * supplied the modified (working-tree) side becomes editable and ⌘S writes the
 * edited content back through the callback (E7-03).
 */

import { Suspense, lazy, useCallback, useRef, type ReactElement } from 'react'
import type { editor as MonacoEditorNs } from 'monaco-editor'
import type { DiffOnMount } from '@monaco-editor/react'

import { useThemeStore } from '../store/themeStore'

const DiffEditor = lazy(() =>
  import('@monaco-editor/react').then((mod) => ({ default: mod.DiffEditor })),
)

export interface DiffViewProps {
  /** Left-hand side (e.g. HEAD or index). */
  original: string
  /** Right-hand side (e.g. working tree). */
  modified: string
  /** Monaco language id; controls syntax highlighting on both sides. */
  language: string
  /**
   * When provided, the modified side is editable and ⌘S calls this with the
   * current modified-side text (E7-03). When omitted the diff is read-only.
   */
  onSaveModified?: (value: string) => void
}

export default function DiffView(props: DiffViewProps): ReactElement {
  const { original, modified, language, onSaveModified } = props
  const resolvedTheme = useThemeStore((s) => s.monacoTheme)
  const editable = onSaveModified !== undefined
  const onSaveRef = useRef(onSaveModified)
  onSaveRef.current = onSaveModified

  const handleMount: DiffOnMount = useCallback((diffEditor, monaco) => {
    if (onSaveRef.current === undefined) return
    const modifiedEditor = diffEditor.getModifiedEditor()
    modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const value = modifiedEditor.getValue()
      onSaveRef.current?.(value)
    })
  }, [])

  const options: MonacoEditorNs.IStandaloneDiffEditorConstructionOptions = {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    minimap: { enabled: false },
    quickSuggestions: false,
  }

  return (
    <Suspense fallback={<div className="monaco-loading" aria-busy="true" />}>
      <DiffEditor
        original={original}
        modified={modified}
        language={language}
        theme={resolvedTheme}
        onMount={handleMount}
        options={{ ...options, readOnly: !editable }}
      />
    </Suspense>
  )
}
