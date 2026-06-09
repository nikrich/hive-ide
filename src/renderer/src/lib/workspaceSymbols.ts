/**
 * Workspace symbol search (E2-07).
 *
 * Uses Monaco's TypeScript worker `getNavigateToItems` to find symbols across
 * the TS/JS program (open files + everything the TS service has resolved), and
 * fans the same query out to connected plugin-LSP servers via
 * `workspace/symbol` (see lspWorkspaceSymbols.ts), merging the results with
 * the TS worker taking precedence on duplicates.
 */

import { getActiveLspClients } from './lspClient'
import { queryLspWorkspaceSymbols } from './lspWorkspaceSymbols'
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
  if (query.trim() === '') return []
  const [ts, lsp] = await Promise.all([
    queryTsWorkspaceSymbols(query, max),
    queryLspWorkspaceSymbols(getActiveLspClients(), query, max).catch(() => []),
  ])
  // De-dupe on path:line:name (TS worker wins on ties).
  const seen = new Set(ts.map((s) => `${s.path}:${s.line}:${s.name}`))
  const merged = [...ts]
  for (const s of lsp) {
    const key = `${s.path}:${s.line}:${s.name}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(s)
  }
  return merged.slice(0, max)
}

async function queryTsWorkspaceSymbols(
  query: string,
  max: number,
): Promise<WorkspaceSymbol[]> {
  const monaco = getMonacoEnv()
  if (monaco === null) return []
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
