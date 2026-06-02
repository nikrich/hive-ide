/**
 * Hive IDE — Monaco editor wrapper (STORY-023).
 *
 * Thin React wrapper around `@monaco-editor/react`. The Welcome screen
 * never touches an editor, so this module is loaded via dynamic import
 * (React.lazy) — that keeps Monaco's ~5 MB bundle (and the @monaco-editor
 * wrapper itself) out of the initial renderer chunk.
 *
 * Public contract is exactly the `MonacoEditorProps` shape called out in
 * the REQ-002 design doc:
 *
 *   path                — drives language detection via languageForPath
 *   value               — the model contents
 *   onChange(next)      — fires on every keystroke
 *   onSave()            — bound to ⌘S / Ctrl+S inside the editor
 *   viewState?          — optional scroll + cursor + folds state to restore
 *   onViewStateChange?  — fires on blur / disposal with editor.saveViewState()
 *
 * State (open tab, dirty flag, etc.) lives in the parent (Editor.tsx,
 * STORY-024). This component is intentionally store-agnostic so it can be
 * mounted from anywhere — tests, storybook, future panes — without
 * dragging Zustand along.
 */

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import type * as Monaco from 'monaco-editor'
import type { editor } from 'monaco-editor'
import type { BeforeMount, OnChange, OnMount } from '@monaco-editor/react'

import { languageForPath } from '../lib/languageForPath'
import { registerPluginWithMonaco } from '../lib/pluginMonaco'
import { useWorkspaceStore } from '../store/workspaceStore'

// Reused empty array literal so the "no enabled plugins" path returns the
// same reference each call — Zustand selectors use `===` equality, and a
// fresh `[]` per render triggers an infinite store-rerender loop.
const EMPTY_IDS: readonly string[] = Object.freeze([])
const EMPTY_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({})

// ---------------------------------------------------------------------------
// Dynamic import. React.lazy turns the @monaco-editor/react module into a
// code-split chunk that the bundler emits separately; the chunk (and its
// peer monaco-editor) is only fetched the first time a <MonacoEditor /> is
// rendered, which is what keeps the Welcome screen cheap.
// ---------------------------------------------------------------------------

const Editor = lazy(() =>
  import('@monaco-editor/react').then((mod) => ({ default: mod.default })),
)

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MonacoEditorProps {
  /** Absolute path of the file — drives language detection. */
  path: string
  /** Current model contents. Updates flow back through `onChange`. */
  value: string
  /** Fired on every model content change. */
  onChange: (next: string) => void
  /** Fired when ⌘S / Ctrl+S is pressed inside the editor. */
  onSave: () => void
  /**
   * Optional editor view state (scroll, cursor, folds) to restore on mount.
   * When the parent switches tabs back to a file it had previously opened,
   * pass the saved state here to land the user where they were.
   */
  viewState?: editor.ICodeEditorViewState
  /**
   * Fired on blur and on disposal with the current `saveViewState()` result.
   * Persist the value so it can be passed back as `viewState` next mount.
   */
  onViewStateChange?: (s: editor.ICodeEditorViewState) => void
}

// ---------------------------------------------------------------------------
// MonacoEditor
// ---------------------------------------------------------------------------

function MonacoEditor(props: MonacoEditorProps): ReactElement {
  const { path, value, onChange, onSave, viewState, onViewStateChange } = props

  // Hold the live editor instance so the unmount cleanup can flush its
  // viewState before Monaco disposes it.
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  // ----- plugins ------------------------------------------------------
  // REQ-006: enabled plugins register their language contributions with
  // Monaco. Use state (not a ref) for the Monaco namespace so the
  // registration effect re-runs after `beforeMount` captures it — a ref
  // would silently bail on the initial render and never re-fire. The
  // `monaco` value is set inside `handleBeforeMount`, then read as a
  // dependency by the registration effect below.
  const [monacoNs, setMonacoNs] = useState<typeof Monaco | null>(null)
  const plugins = useWorkspaceStore((s) => s.plugins)
  // Subscribe to the stable fields and derive `enabledForProject` outside
  // the selector. Returning `(map[id] ?? [])` directly from the selector
  // synthesizes a fresh `[]` every call when the key is missing, which
  // Zustand reads as a state change and turns into an infinite-update loop.
  const projectId = useWorkspaceStore((s) => s.project?.id ?? null)
  const enabledMap = useWorkspaceStore((s) => s.enabledPlugins)
  const enabledForProject = useMemo<readonly string[]>(
    () => (projectId ? (enabledMap[projectId] ?? EMPTY_IDS) : EMPTY_IDS),
    [projectId, enabledMap],
  )

  // Build the plugin → extension → languageId map so files matching a
  // plugin-declared extension pick up the contributed Monaco language id
  // instead of falling back to 'plaintext'. Memoized so identity is stable
  // across renders when nothing relevant has changed.
  const pluginExtensions = useMemo<Readonly<Record<string, string>>>(() => {
    if (enabledForProject.length === 0) return EMPTY_EXTENSIONS
    const map: Record<string, string> = {}
    for (const id of enabledForProject) {
      const plugin = plugins.find((p) => p.manifest.id === id)
      if (plugin === undefined || !plugin.valid) continue
      const langs = plugin.manifest.contributes?.languages ?? []
      for (const lang of langs) {
        for (const raw of lang.extensions ?? []) {
          // Manifests typically use ".smile"; strip the leading dot + lower.
          const ext = raw.startsWith('.') ? raw.slice(1) : raw
          map[ext.toLowerCase()] = lang.id
        }
      }
    }
    return map
  }, [enabledForProject, plugins])

  // Latest-prop refs. The Monaco command callback is registered once at
  // mount via editor.addCommand, so it must reach through a ref to see the
  // current onSave / onViewStateChange — otherwise it would capture the
  // first render's closures and never update.
  const onSaveRef = useRef(onSave)
  const onViewStateChangeRef = useRef(onViewStateChange)

  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange
  }, [onViewStateChange])

  // The initial viewState is only consulted once — on mount — so capture it
  // in a ref to avoid restoring repeatedly if the prop reference changes.
  const initialViewStateRef = useRef(viewState)

  // Configure Monaco's TS language service. Per the spec we only set the
  // three required defaults; per-project tsconfig loading is deferred.
  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    setMonacoNs(monaco as unknown as typeof Monaco)
    const ts = monaco.languages.typescript
    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
    })
  }, [])

  // Register enabled plugins whenever the enabled set or the live plugins
  // list changes — AND once Monaco itself has loaded (the `monacoNs` state
  // gates the effect on Monaco readiness). `registerPluginWithMonaco` is
  // internally guarded against double-registration so re-renders are cheap.
  useEffect(() => {
    const monaco = monacoNs
    if (monaco === null) return

    let cancelled = false
    void (async () => {
      for (const id of enabledForProject) {
        const plugin = plugins.find((p) => p.manifest.id === id)
        if (plugin === undefined || !plugin.valid) continue
        if (cancelled) return
        await registerPluginWithMonaco(plugin, monaco)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabledForProject, plugins, monacoNs])

  const handleMount: OnMount = useCallback((ed, monaco) => {
    editorRef.current = ed

    // ⌘S / Ctrl+S → onSave. addCommand swallows the default Monaco binding
    // (no-op anyway) so the keystroke never bubbles out to the browser /
    // Electron save handler.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current()
    })

    // Restore the previous viewState (cursor, scroll, folds) if the parent
    // gave us one. Restoring here — inside onMount — is the only point
    // Monaco guarantees a layouted editor, so doing it any earlier would
    // be a no-op.
    if (initialViewStateRef.current) {
      ed.restoreViewState(initialViewStateRef.current)
    }

    // Flush viewState whenever the operator's focus leaves the editor.
    // Disposal is covered by the React cleanup effect below, which still
    // sees a valid `editorRef.current` because the wrapper disposes the
    // editor *after* React unmounts the host element.
    ed.onDidBlurEditorWidget(() => {
      const state = ed.saveViewState()
      if (state) onViewStateChangeRef.current?.(state)
    })
  }, [])

  // onChange is wrapped to coerce Monaco's `string | undefined` into the
  // plain `string` our caller expects. Undefined only shows up during
  // teardown, so collapsing it to '' is safe.
  const handleChange: OnChange = useCallback(
    (next) => {
      onChange(next ?? '')
    },
    [onChange],
  )

  // On unmount: snapshot viewState one last time. This covers tab close,
  // file rename, and component remount paths that don't trigger blur.
  useEffect(() => {
    return () => {
      const ed = editorRef.current
      if (!ed) return
      const state = ed.saveViewState()
      if (state) onViewStateChangeRef.current?.(state)
      editorRef.current = null
    }
  }, [])

  return (
    <Suspense fallback={<div className="monaco-loading" aria-busy="true" />}>
      <Editor
        path={path}
        value={value}
        language={languageForPath(path, pluginExtensions)}
        theme="vs-dark"
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        onChange={handleChange}
      />
    </Suspense>
  )
}

export default MonacoEditor
