/**
 * Find-all-references (E2-11).
 *
 * Queries Monaco's TS worker `getReferencesAtPosition` for the symbol under the
 * active editor's cursor and resolves each reference to a file/line/preview for
 * the references panel (a list UI, vs the built-in peek).
 */

import { getActiveEditor } from './activeEditor'
import { getMonacoEnv } from './monacoEnv'

export interface ReferenceHit {
  path: string
  line: number
  column: number
  preview: string
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
  if (!model || !pos || !/typescript|javascript/.test(model.getLanguageId())) {
    return { symbol: '', hits: [] }
  }
  const symbol = model.getWordAtPosition(pos)?.word ?? ''
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
