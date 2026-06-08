/**
 * Command registry (E6-01) + context keys (E6-05).
 *
 * The single place every feature contributes invokable commands. A command is
 * `{ id, title, category?, when?, handler }`. Anything can register one; the
 * command palette (E6-02), keybindings (E4-03), menus, and plugins
 * (E10-03) all dispatch by id rather than wiring raw handlers.
 *
 * Context keys are a flat bag of values (`editorFocus`, `hasProject`,
 * `view`, `debugging`, …) that `when`-clauses are evaluated against to gate
 * a command's visibility / a keybinding's applicability.
 *
 * Implemented as a Zustand store so the palette re-renders when commands or
 * context change. Handlers are plain functions held in state — fine for
 * Zustand, which never serialises.
 */

import { create } from 'zustand'

import { evaluateWhen, type WhenContext, type WhenValue } from '../lib/when'

export interface Command {
  /** Unique, namespaced id, e.g. `'editor.action.find'`. */
  id: string
  /** Human title shown in the palette. */
  title: string
  /** Optional grouping prefix shown before the title (e.g. `Editor`). */
  category?: string
  /** Optional when-clause gating palette visibility. */
  when?: string
  /** The work the command performs. May be async. */
  handler: (...args: unknown[]) => void | Promise<void>
}

/** Max number of recently-run command ids retained for "float to top". */
const RECENT_CAP = 20

export interface CommandState {
  /** Registered commands keyed by id. */
  commands: Record<string, Command>
  /** Flat context-key bag for when-clause evaluation. */
  context: WhenContext
  /** Recently-run command ids, most-recent first (deduped, capped). */
  recent: string[]

  /**
   * Register a command. Returns an unregister function. Re-registering an id
   * replaces the prior command (and warns in dev — a duplicate id is almost
   * always a bug).
   */
  register: (cmd: Command) => () => void
  /** Remove a command by id. */
  unregister: (id: string) => void
  /**
   * Execute a command by id. No-op (with a warning) for an unknown id.
   * Records the id in `recent`. Returns the handler's result/promise.
   */
  execute: (id: string, ...args: unknown[]) => void
  /** Set a single context key. */
  setContext: (key: string, value: WhenValue) => void
  /** Merge several context keys at once. */
  setContextBatch: (patch: Record<string, WhenValue>) => void
}

export const useCommandStore = create<CommandState>((set, get) => ({
  commands: {},
  context: {},
  recent: [],

  register: (cmd) => {
    if (
      import.meta.env?.DEV &&
      Object.prototype.hasOwnProperty.call(get().commands, cmd.id)
    ) {
      // eslint-disable-next-line no-console
      console.warn(`command: duplicate registration for "${cmd.id}"`)
    }
    set((s) => ({ commands: { ...s.commands, [cmd.id]: cmd } }))
    return () => get().unregister(cmd.id)
  },

  unregister: (id) =>
    set((s) => {
      if (!(id in s.commands)) return {}
      const commands = { ...s.commands }
      delete commands[id]
      return { commands }
    }),

  execute: (id, ...args) => {
    const cmd = get().commands[id]
    if (cmd === undefined) {
      // eslint-disable-next-line no-console
      console.warn(`command: no command registered for "${id}"`)
      return
    }
    set((s) => ({
      recent: [id, ...s.recent.filter((r) => r !== id)].slice(0, RECENT_CAP),
    }))
    void cmd.handler(...args)
  },

  setContext: (key, value) =>
    set((s) =>
      s.context[key] === value
        ? {}
        : { context: { ...s.context, [key]: value } },
    ),

  setContextBatch: (patch) =>
    set((s) => {
      let changed = false
      const next: Record<string, WhenValue> = { ...s.context }
      for (const [k, v] of Object.entries(patch)) {
        if (next[k] !== v) {
          next[k] = v
          changed = true
        }
      }
      return changed ? { context: next } : {}
    }),
}))

/**
 * The commands currently visible given the context — registered commands whose
 * `when`-clause passes. Sorted by category then title for a stable palette.
 */
export function visibleCommands(
  commands: Record<string, Command>,
  context: WhenContext,
): Command[] {
  return Object.values(commands)
    .filter((c) => evaluateWhen(c.when, context))
    .sort((a, b) => {
      const ca = a.category ?? ''
      const cb = b.category ?? ''
      if (ca !== cb) return ca.localeCompare(cb)
      return a.title.localeCompare(b.title)
    })
}

/** Imperative helpers for non-React call sites (keybindings, plugins). */
export const commands = {
  register: (cmd: Command): (() => void) => useCommandStore.getState().register(cmd),
  execute: (id: string, ...args: unknown[]): void =>
    useCommandStore.getState().execute(id, ...args),
  setContext: (key: string, value: WhenValue): void =>
    useCommandStore.getState().setContext(key, value),
  get: (id: string): Command | undefined => useCommandStore.getState().commands[id],
}

export type { WhenContext, WhenValue }
