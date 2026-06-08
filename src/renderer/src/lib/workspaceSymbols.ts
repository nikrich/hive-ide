/**
 * Workspace symbol search (E2-07).
 *
 * Uses Monaco's TypeScript worker `getNavigateToItems` to find symbols across
 * the TS/JS program (open files + everything the TS service has resolved). This
 * covers the languages the IDE ships natively; plugin-LSP `workspace/symbol`
 * would extend it once those clients expose it.
 */

import { getMonacoEnv } from './monacoEnv'

export interface WorkspaceSymbol {
  name: string
  kind: string
  containerName: string
  /** Absolute file path. */
  path: string
  line: number
  column: number
}

/** Minimal shape of the TS worker method we use (not in Monaco's d.ts). */
interface TsNavWorker {
  getNavigateToItems?: (
    searchValue: string,
  ) => Promise<
    Array<{
      name: string
      kind: string
      containerName?: string
      fileName: string
      textSpan: { start: number; length: number }
    }>
  >
}

export async function queryWorkspaceSymbols(
  query: string,
  max = 200,
): Promise<WorkspaceSymbol[]> {
  const monaco = getMonacoEnv()
  if (monaco === null || query.trim() === '') return []
  const tsModels = monaco.editor
    .getModels()
    .filter((m) => /typescript|javascript/.test(m.getLanguageId()))
  if (tsModels.length === 0) return []

  try {
    // Monaco's bundled d.ts under-types this namespace; cast to the runtime shape.
    const ts = monaco.languages.typescript as unknown as {
      getTypeScriptWorker: () => Promise<(...uris: unknown[]) => Promise<unknown>>
    }
    const getWorker = await ts.getTypeScriptWorker()
    const worker = (await getWorker(tsModels[0].uri)) as unknown as TsNavWorker
    if (typeof worker.getNavigateToItems !== 'function') return []
    const items = await worker.getNavigateToItems(query)
    return items.slice(0, max).map((it) => {
      const model =
        monaco.editor.getModels().find((m) => m.uri.toString() === it.fileName) ??
        null
      const pos = model
        ? model.getPositionAt(it.textSpan.start)
        : { lineNumber: 1, column: 1 }
      const path = model ? model.uri.fsPath : it.fileName
      return {
        name: it.name,
        kind: it.kind,
        containerName: it.containerName ?? '',
        path,
        line: pos.lineNumber,
        column: pos.column,
      }
    })
  } catch {
    return []
  }
}
