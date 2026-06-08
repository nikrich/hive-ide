/**
 * Debug IPC handlers (E3-01, E3-04..E3-07).
 *
 * Bridges the renderer to a single active {@link DebugSession}: starts a debug
 * adapter for a `launch.json` config, runs the DAP handshake (initialize →
 * launch/attach → setBreakpoints → configurationDone), forwards adapter events
 * to the renderer, and exposes the stepping / inspection requests (continue,
 * next, stepIn/Out, pause, stackTrace, scopes, variables, evaluate).
 *
 * Adapter resolution: a `type → { command, args }` map. `node` resolves to a
 * bundled/downloaded js-debug per the design spec; when the adapter binary is
 * absent, `start` rejects with a clear message (the session machinery is fully
 * built — only the adapter binary is a separate download step, E3-14).
 */

import { spawn } from 'node:child_process'
import { ipcMain, type BrowserWindow } from 'electron'

import { DebugSession, type DapEvent, type DapTransport } from './session'
import type { DebugConfiguration } from '../../types/launch'

export const DEBUG_CHANNELS = {
  start: 'debug:start',
  stop: 'debug:stop',
  request: 'debug:request',
  setBreakpoints: 'debug:set-breakpoints',
  evtEvent: 'event:debug:event',
} as const

export interface DebugHandlersOptions {
  getMainWindow: () => BrowserWindow | null
  /** Resolve a debug `type` to an adapter command. Returns null when absent. */
  resolveAdapter?: (type: string) => { command: string; args: string[] } | null
}

/** Breakpoints sent on configuration, keyed by absolute file path. */
type BreakpointMap = Record<string, number[]>

function defaultResolveAdapter(
  type: string,
): { command: string; args: string[] } | null {
  // js-debug exposes a DAP server entry; the path is provided once the adapter
  // is downloaded (see the marketplace/debug spec). Resolved from an env var so
  // a packaged build or a downloaded bundle can point at it without a rebuild.
  if (type === 'node' || type === 'pwa-node') {
    const entry = process.env.HIVE_JS_DEBUG_ADAPTER
    if (entry) return { command: process.execPath, args: [entry] }
  }
  const explicit = process.env[`HIVE_DEBUG_ADAPTER_${type.toUpperCase()}`]
  if (explicit) return { command: explicit, args: [] }
  return null
}

/** Wrap a spawned adapter's stdio in the session's transport shape. */
function spawnTransport(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): DapTransport {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return {
    send: (data) => child.stdin?.write(data),
    onData: (cb) => child.stdout?.on('data', (c: Buffer) => cb(c)),
    onClose: (cb) => child.on('close', () => cb()),
    dispose: () => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    },
  }
}

export function registerDebugHandlers(opts: DebugHandlersOptions): () => void {
  const resolveAdapter = opts.resolveAdapter ?? defaultResolveAdapter
  let session: DebugSession | null = null

  const push = (event: DapEvent): void => {
    const win = opts.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(DEBUG_CHANNELS.evtEvent, event)
  }

  const teardownSession = (): void => {
    session?.dispose()
    session = null
  }

  ipcMain.handle(
    DEBUG_CHANNELS.start,
    async (
      _e,
      payload: { config: DebugConfiguration; breakpoints: BreakpointMap },
    ): Promise<{ ok: boolean; error?: string }> => {
      const { config, breakpoints } = payload
      const adapter = resolveAdapter(config.type)
      if (adapter === null) {
        return {
          ok: false,
          error: `No debug adapter installed for type "${config.type}". Install one (see docs/specs/2026-06-08-debugging-dap-design.md).`,
        }
      }
      teardownSession()
      const transport = spawnTransport(
        adapter.command,
        adapter.args,
        config.cwd,
        config.env,
      )

      // One-shot latch for the adapter's `initialized` event — the cue to send
      // breakpoints + configurationDone (per the DAP launch sequence).
      let signalInitialized: () => void = () => undefined
      const initialized = new Promise<void>((resolve) => {
        signalInitialized = resolve
      })

      const active = new DebugSession(transport, (event) => {
        if (event.event === 'initialized') signalInitialized()
        push(event)
        if (event.event === 'terminated' || event.event === 'exited') {
          teardownSession()
        }
      })
      session = active

      try {
        await active.request('initialize', {
          clientID: 'hive-ide',
          adapterID: config.type,
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: 'path',
          supportsRunInTerminalRequest: false,
        })
        // Send launch/attach without awaiting — the adapter emits `initialized`
        // before this resolves, at which point we configure breakpoints.
        void active.request(config.request, config)
        // Bounded wait: some adapters that don't emit `initialized` still
        // accept configuration after launch.
        await Promise.race([
          initialized,
          new Promise<void>((r) => setTimeout(r, 2000)),
        ])
        for (const [file, lines] of Object.entries(breakpoints)) {
          await active.request('setBreakpoints', {
            source: { path: file },
            breakpoints: lines.map((line) => ({ line })),
          })
        }
        await active.request('configurationDone')
        return { ok: true }
      } catch (err) {
        teardownSession()
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(DEBUG_CHANNELS.stop, async (): Promise<void> => {
    if (session) {
      try {
        await session.request('disconnect', { terminateDebuggee: true })
      } catch {
        // adapter may already be gone
      }
    }
    teardownSession()
  })

  ipcMain.handle(
    DEBUG_CHANNELS.request,
    async (_e, payload: { command: string; args?: unknown }): Promise<unknown> => {
      if (session === null) throw new Error('debug: no active session')
      const res = await session.request(payload.command, payload.args)
      if (!res.success) throw new Error(res.message ?? `debug: ${payload.command} failed`)
      return res.body
    },
  )

  ipcMain.handle(
    DEBUG_CHANNELS.setBreakpoints,
    async (_e, payload: { file: string; lines: number[] }): Promise<void> => {
      if (session === null) return
      await session.request('setBreakpoints', {
        source: { path: payload.file },
        breakpoints: payload.lines.map((line) => ({ line })),
      })
    },
  )

  return () => {
    teardownSession()
    ipcMain.removeHandler(DEBUG_CHANNELS.start)
    ipcMain.removeHandler(DEBUG_CHANNELS.stop)
    ipcMain.removeHandler(DEBUG_CHANNELS.request)
    ipcMain.removeHandler(DEBUG_CHANNELS.setBreakpoints)
  }
}
