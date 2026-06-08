/**
 * Monaco marker → problems store bridge (E9-01).
 *
 * Both the built-in TypeScript/JS worker and every plugin LSP publish their
 * diagnostics through Monaco's marker API (`setModelMarkers`). Rather than tap
 * each producer, we mirror Monaco's aggregated marker store into the renderer
 * `problemsStore` via a single `onDidChangeMarkers` listener. That gives the
 * Problems panel + status-bar counts one consistent source for every language.
 *
 * `installMarkerBridge` is idempotent — safe to call on every editor mount.
 */

import type * as Monaco from 'monaco-editor'

import {
  useProblemsStore,
  type Diagnostic,
  type DiagnosticSeverity,
} from '../store/problemsStore'

let installed = false

/** Map Monaco's MarkerSeverity (Error=8…Hint=1) to our severity union. */
function mapSeverity(
  severity: number,
  monaco: typeof Monaco,
): DiagnosticSeverity {
  const S = monaco.MarkerSeverity
  if (severity === S.Error) return 'error'
  if (severity === S.Warning) return 'warning'
  if (severity === S.Info) return 'info'
  return 'hint'
}

/** Resolve a marker resource to an absolute filesystem path. */
function resourcePath(resource: Monaco.Uri): string {
  // `fsPath` returns the OS path for file:// uris and the bare path otherwise,
  // which matches the absolute paths the workspace store keys tabs by.
  return resource.fsPath || resource.path
}

export function installMarkerBridge(monaco: typeof Monaco): void {
  if (installed) return
  installed = true

  const sync = (resources: ReadonlyArray<Monaco.Uri>): void => {
    const store = useProblemsStore.getState()
    for (const resource of resources) {
      const file = resourcePath(resource)
      const markers = monaco.editor.getModelMarkers({ resource })
      const diagnostics: Diagnostic[] = markers.map((m) => ({
        file,
        line: m.startLineNumber,
        column: m.startColumn,
        endLine: m.endLineNumber,
        endColumn: m.endColumn,
        severity: mapSeverity(m.severity, monaco),
        message: m.message,
        source: m.source,
        code:
          typeof m.code === 'object' && m.code !== null
            ? m.code.value
            : (m.code ?? undefined),
      }))
      store.setForFile(file, diagnostics)
    }
  }

  monaco.editor.onDidChangeMarkers(sync)
}
