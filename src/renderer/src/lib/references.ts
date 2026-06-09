/**
 * Find-all-references (E2-11).
 *
 * For TS/JS, queries Monaco's TS worker `getReferencesAtPosition` for the
 * symbol under the active editor's cursor. For other languages, queries the
 * connected plugin LSP server via `textDocument/references`. Each reference is
 * resolved to a file/line/preview for the references panel (a list UI, vs the
 * built-in peek).
 */

import { getActiveEditor } from './activeEditor'
import { findClientForLanguage } from './lspClient'
import { fileUriToPath } from './lspWorkspaceSymbols'
import { getMonacoEnv } from './monacoEnv'

export interface ReferenceHit {
  path: string
  line: number
  column: number
  preview: string
}

interface LspLocationLike {
  uri?: unknown
  range?: { start?: { line?: unknown; character?: unknown } }
}

interface ModelLike {
  uri: { toString(): string; fsPath: string }
  getLineContent(line: number): string
}

/** LSP Location[] → ReferenceHit[], previewing from open Monaco models. */
export function lspLocationsToHits(
  locations: unknown,
  models: readonly ModelLike[],
): ReferenceHit[] {
  if (!Array.isArray(locations)) return []
  const hits: ReferenceHit[] = []
  for (const raw of locations as LspLocationLike[]) {
    if (typeof raw?.uri !== 'string') continue
    const start = raw.range?.start
    const line = (typeof start?.line === 'number' ? start.line : 0) + 1
    const column = (typeof start?.character === 'number' ? start.character : 0) + 1
    const model = models.find((m) => m.uri.toString() === raw.uri) ?? null
    let preview = ''
    if (model !== null) {
      try {
        preview = model.getLineContent(line).trim()
      } catch {
        preview = ''
      }
    }
    hits.push({ path: model ? model.uri.fsPath : fileUriToPath(raw.uri), line, column, preview })
  }
  return hits
}

interface TsRefWorker {
  getReferencesAtPosition?: (
    fileName: string,
    position: number,
  ) => Promise<Array<{ fileName: string; textSpan: { start: number; length: number } }>>
}

export async function queryReferences(): Promise<{
  symbol: string
  hits: ReferenceHit[]
}> {
  const ed = getActiveEditor()
  const monaco = getMonacoEnv()
  if (!ed || !monaco) return { symbol: '', hits: [] }
  const model = ed.getModel()
  const pos = ed.getPosition()
  if (!model || !pos) return { symbol: '', hits: [] }
  const symbol = model.getWordAtPosition(pos)?.word ?? ''

  if (!/typescript|javascript/.test(model.getLanguageId())) {
    const client = findClientForLanguage(model.getLanguageId())
    if (client === null) return { symbol, hits: [] }
    try {
      const result = await client.connection.sendRequest('textDocument/references', {
        textDocument: { uri: model.uri.toString() },
        position: { line: pos.lineNumber - 1, character: pos.column - 1 },
        context: { includeDeclaration: true },
      })
      return { symbol, hits: lspLocationsToHits(result, monaco.editor.getModels()) }
    } catch {
      return { symbol, hits: [] }
    }
  }

  const offset = model.getOffsetAt(pos)
  try {
    const ts = monaco.languages.typescript as unknown as {
      getTypeScriptWorker: () => Promise<(...uris: unknown[]) => Promise<unknown>>
    }
    const getWorker = await ts.getTypeScriptWorker()
    const worker = (await getWorker(model.uri)) as unknown as TsRefWorker
    if (typeof worker.getReferencesAtPosition !== 'function') return { symbol, hits: [] }
    const refs = (await worker.getReferencesAtPosition(model.uri.toString(), offset)) ?? []
    const hits = refs.map((r) => {
      const m = monaco.editor.getModels().find((mm) => mm.uri.toString() === r.fileName)
      const p = m ? m.getPositionAt(r.textSpan.start) : { lineNumber: 1, column: 1 }
      return {
        path: m ? m.uri.fsPath : r.fileName,
        line: p.lineNumber,
        column: p.column,
        preview: m ? m.getLineContent(p.lineNumber).trim() : '',
      }
    })
    return { symbol, hits }
  } catch {
    return { symbol, hits: [] }
  }
}
