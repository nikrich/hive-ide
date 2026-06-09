/**
 * Workspace-wide diagnostics (E9-06).
 *
 * Monaco only diagnoses open models; this walks the project's TS/JS files,
 * loads each into a temporary model, asks the TS worker for semantic +
 * syntactic diagnostics, and publishes them to the problems store. On-demand
 * (a command) + bounded by a file cap so a huge tree can't lock the renderer.
 */

import { getMonacoEnv } from './monacoEnv'
import {
  useProblemsStore,
  type Diagnostic,
  type DiagnosticSeverity,
} from '../store/problemsStore'
import { progress } from '../store/progressStore'

const TS_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/
const FILE_CAP = 400

interface TsDiag {
  start?: number
  length?: number
  category: number
  code: number
  messageText: string | { messageText: string; next?: unknown }
}
interface TsDiagWorker {
  getSemanticDiagnostics?: (fileName: string) => Promise<TsDiag[]>
  getSyntacticDiagnostics?: (fileName: string) => Promise<TsDiag[]>
}

function flattenMessage(m: TsDiag['messageText']): string {
  return typeof m === 'string' ? m : m.messageText
}

function severityFor(category: number): DiagnosticSeverity {
  // ts.DiagnosticCategory: 0 Warning, 1 Error, 2 Suggestion, 3 Message
  if (category === 1) return 'error'
  if (category === 0) return 'warning'
  if (category === 2) return 'hint'
  return 'info'
}

export interface WorkspaceDiagnosticsResult {
  filesScanned: number
  truncated: boolean
}

export async function runWorkspaceDiagnostics(
  roots: string[],
  exclude: string[],
): Promise<WorkspaceDiagnosticsResult> {
  const monaco = getMonacoEnv()
  const bridge = window.hive
  if (monaco === null || !bridge || roots.length === 0) {
    return { filesScanned: 0, truncated: false }
  }
  progress.start('workspace-diagnostics', 'Analyzing workspace…')
  try {
    const { files } = await bridge.search.listFiles({ roots, exclude, max: 20000 })
    const tsFiles = files.filter((f) => TS_RE.test(f))
    const truncated = tsFiles.length > FILE_CAP
    const batch = tsFiles.slice(0, FILE_CAP)

    const ts = monaco.languages.typescript as unknown as {
      getTypeScriptWorker: () => Promise<(...uris: unknown[]) => Promise<unknown>>
    }
    const getWorker = await ts.getTypeScriptWorker()

    for (const file of batch) {
      let model = monaco.editor.getModels().find((m) => m.uri.fsPath === file) ?? null
      let created = false
      if (model === null) {
        try {
          const { contents } = await bridge.fs.readFile(file)
          model = monaco.editor.createModel(contents, undefined, monaco.Uri.file(file))
          created = true
        } catch {
          continue
        }
      }
      try {
        const worker = (await getWorker(model.uri)) as unknown as TsDiagWorker
        const uriStr = model.uri.toString()
        const [sem, syn] = await Promise.all([
          worker.getSemanticDiagnostics?.(uriStr) ?? [],
          worker.getSyntacticDiagnostics?.(uriStr) ?? [],
        ])
        const diags: Diagnostic[] = [...sem, ...syn].map((d) => {
          const pos =
            d.start !== undefined
              ? model.getPositionAt(d.start)
              : { lineNumber: 1, column: 1 }
          return {
            file,
            line: pos.lineNumber,
            column: pos.column,
            severity: severityFor(d.category),
            message: flattenMessage(d.messageText),
            source: 'ts',
            code: d.code,
          }
        })
        useProblemsStore.getState().setForFile(file, diags)
      } finally {
        if (created) model.dispose()
      }
    }
    return { filesScanned: batch.length, truncated }
  } finally {
    progress.end('workspace-diagnostics')
  }
}
