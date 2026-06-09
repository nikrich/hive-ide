/**
 * Debug session store (E3-04..E3-08).
 *
 * Renderer-side mirror of the active DAP session: status, console output, the
 * stopped thread's call stack, the selected frame's scopes/variables, and watch
 * expressions. Adapter events (forwarded by main over `window.hive.debug.onEvent`)
 * are dispatched into here via `handleEvent`; the toolbar/views read from it.
 */

import { create } from 'zustand'

import { useBreakpointsStore } from './breakpointsStore'
import type { DebugConfiguration } from '../../../types/launch'

export type DebugStatus = 'inactive' | 'running' | 'stopped'

export interface StackFrame {
  id: number
  name: string
  line: number
  column: number
  path?: string
}

export interface Scope {
  name: string
  variablesReference: number
  expensive: boolean
}

export interface Variable {
  name: string
  value: string
  variablesReference: number
}

export interface OutputLine {
  category: string
  text: string
}

export interface DebugState {
  status: DebugStatus
  /** Last start error, surfaced in the UI. */
  error: string | null
  output: OutputLine[]
  threadId: number | null
  frames: StackFrame[]
  activeFrameId: number | null
  scopes: Scope[]
  /** Variables keyed by variablesReference (lazy-expanded). */
  variables: Record<number, Variable[]>
  watches: string[]
  watchResults: Record<string, string>
  /** Active exception-breakpoint filters (E3-11), e.g. ['uncaught']. */
  exceptionFilters: string[]

  start: (config: DebugConfiguration) => Promise<void>
  stop: () => Promise<void>
  resume: () => Promise<void>
  next: () => Promise<void>
  stepIn: () => Promise<void>
  stepOut: () => Promise<void>
  pause: () => Promise<void>
  selectFrame: (frameId: number) => Promise<void>
  loadVariables: (ref: number) => Promise<void>
  addWatch: (expr: string) => void
  removeWatch: (expr: string) => void
  toggleExceptionFilter: (filter: string) => void
  refreshWatches: () => Promise<void>
  handleEvent: (event: { event: string; body?: unknown }) => void
  reset: () => void
}

function req(command: string, args?: unknown): Promise<unknown> {
  const bridge = window.hive?.debug
  if (!bridge) return Promise.reject(new Error('debug bridge unavailable'))
  return bridge.request(command, args)
}

export const useDebugStore = create<DebugState>((set, get) => ({
  status: 'inactive',
  error: null,
  output: [],
  threadId: null,
  frames: [],
  activeFrameId: null,
  scopes: [],
  variables: {},
  watches: [],
  watchResults: {},
  exceptionFilters: ['uncaught'],

  start: async (config) => {
    const bridge = window.hive?.debug
    if (!bridge) return
    get().reset()
    set({ status: 'running', error: null })
    const breakpoints = useBreakpointsStore.getState().byFile
    const res = await bridge.start(config, breakpoints)
    if (!res.ok) {
      set({ status: 'inactive', error: res.error ?? 'Failed to start debugging' })
      return
    }
    const filters = get().exceptionFilters
    if (filters.length > 0) {
      await bridge.setExceptionBreakpoints(filters).catch(() => undefined)
    }
  },

  toggleExceptionFilter: (filter) => {
    set((s) => {
      const has = s.exceptionFilters.includes(filter)
      return {
        exceptionFilters: has
          ? s.exceptionFilters.filter((f) => f !== filter)
          : [...s.exceptionFilters, filter],
      }
    })
    if (get().status !== 'inactive') {
      void window.hive?.debug
        .setExceptionBreakpoints(get().exceptionFilters)
        .catch(() => undefined)
    }
  },

  stop: async () => {
    await window.hive?.debug.stop().catch(() => undefined)
    get().reset()
  },

  resume: async () => {
    const threadId = get().threadId
    set({ status: 'running', frames: [], scopes: [], variables: {} })
    await req('continue', { threadId }).catch(() => undefined)
  },
  next: async () => {
    await req('next', { threadId: get().threadId }).catch(() => undefined)
  },
  stepIn: async () => {
    await req('stepIn', { threadId: get().threadId }).catch(() => undefined)
  },
  stepOut: async () => {
    await req('stepOut', { threadId: get().threadId }).catch(() => undefined)
  },
  pause: async () => {
    await req('pause', { threadId: get().threadId }).catch(() => undefined)
  },

  selectFrame: async (frameId) => {
    set({ activeFrameId: frameId, scopes: [], variables: {} })
    try {
      const body = (await req('scopes', { frameId })) as { scopes?: Scope[] }
      set({ scopes: body.scopes ?? [] })
    } catch {
      // adapter may have resumed
    }
  },

  loadVariables: async (ref) => {
    if (get().variables[ref]) return
    try {
      const body = (await req('variables', { variablesReference: ref })) as {
        variables?: Variable[]
      }
      set((s) => ({ variables: { ...s.variables, [ref]: body.variables ?? [] } }))
    } catch {
      // ignore
    }
  },

  addWatch: (expr) =>
    set((s) => (s.watches.includes(expr) ? {} : { watches: [...s.watches, expr] })),
  removeWatch: (expr) =>
    set((s) => ({ watches: s.watches.filter((w) => w !== expr) })),

  handleEvent: (event) => {
    const body = (event.body ?? {}) as Record<string, unknown>
    switch (event.event) {
      case 'output': {
        const text = typeof body.output === 'string' ? body.output : ''
        const category = typeof body.category === 'string' ? body.category : 'console'
        set((s) => ({ output: [...s.output, { category, text }].slice(-1000) }))
        break
      }
      case 'stopped': {
        const threadId = typeof body.threadId === 'number' ? body.threadId : get().threadId
        set({ status: 'stopped', threadId })
        void (async () => {
          try {
            const st = (await req('stackTrace', { threadId })) as {
              stackFrames?: Array<{
                id: number
                name: string
                line: number
                column: number
                source?: { path?: string }
              }>
            }
            const frames: StackFrame[] = (st.stackFrames ?? []).map((f) => ({
              id: f.id,
              name: f.name,
              line: f.line,
              column: f.column,
              path: f.source?.path,
            }))
            set({ frames })
            if (frames[0]) void get().selectFrame(frames[0].id)
            void get().refreshWatches()
          } catch {
            // ignore
          }
        })()
        break
      }
      case 'continued':
        set({ status: 'running', frames: [], scopes: [], variables: {} })
        break
      case 'terminated':
      case 'exited':
        get().reset()
        break
    }
  },

  // Re-evaluate watch expressions against the active frame.
  refreshWatches: async () => {
    const { watches, activeFrameId } = get()
    const results: Record<string, string> = {}
    for (const expr of watches) {
      try {
        const body = (await req('evaluate', {
          expression: expr,
          frameId: activeFrameId ?? undefined,
          context: 'watch',
        })) as { result?: string }
        results[expr] = body.result ?? ''
      } catch {
        results[expr] = '<error>'
      }
    }
    set({ watchResults: results })
  },

  reset: () =>
    set({
      status: 'inactive',
      threadId: null,
      frames: [],
      activeFrameId: null,
      scopes: [],
      variables: {},
      watchResults: {},
    }),
}))
