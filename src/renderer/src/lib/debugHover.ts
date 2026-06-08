/**
 * Debug hover evaluation (E3-13).
 *
 * Registers a Monaco hover provider that, while a debug session is paused,
 * evaluates the hovered symbol in the active stack frame and shows its value.
 * Idempotent — safe to call on every editor mount.
 */

import type * as Monaco from 'monaco-editor'

import { useDebugStore } from '../store/debugStore'

let installed = false

export function installDebugHover(monaco: typeof Monaco): void {
  if (installed) return
  installed = true

  monaco.languages.registerHoverProvider('*', {
    provideHover: async (model, position) => {
      const debug = useDebugStore.getState()
      if (debug.status !== 'stopped') return null
      const word = model.getWordAtPosition(position)
      if (word === null) return null
      try {
        const body = (await window.hive.debug.request('evaluate', {
          expression: word.word,
          frameId: debug.activeFrameId ?? undefined,
          context: 'hover',
        })) as { result?: string }
        if (body.result === undefined || body.result === '') return null
        return {
          range: new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          ),
          contents: [{ value: '```\n' + body.result + '\n```' }],
        }
      } catch {
        return null
      }
    },
  })
}
