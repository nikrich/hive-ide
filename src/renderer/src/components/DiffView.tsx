/**
 * Monaco DiffEditor wrapper — REQ-008.
 *
 * Mirrors {@link MonacoEditor}'s code-splitting strategy: the underlying
 * `@monaco-editor/react` module is lazy-loaded so a session that never
 * opens a diff doesn't pay Monaco's bundle cost.
 *
 * Read-only for v1. The user reviews changes here; staging / discarding /
 * editing happens through the SourceControlView's row buttons or by
 * opening the file in the normal editor.
 */

import { Suspense, lazy, type ReactElement } from 'react'

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
  /** Defaults to true; v1 never lets the user edit through the diff. */
  readOnly?: boolean
}

export default function DiffView(props: DiffViewProps): ReactElement {
  const { original, modified, language, readOnly = true } = props

  return (
    <Suspense fallback={<div className="monaco-loading" aria-busy="true" />}>
      <DiffEditor
        original={original}
        modified={modified}
        language={language}
        theme="vs-dark"
        options={{
          readOnly,
          renderSideBySide: true,
          // Disable the in-editor minimap on the diff — busy enough already.
          minimap: { enabled: false },
          // Keep the LSP-ish features quiet on the read-only side.
          quickSuggestions: false,
        }}
      />
    </Suspense>
  )
}
