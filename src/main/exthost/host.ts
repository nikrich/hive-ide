/**
 * Extension host (E10-09).
 *
 * Runs plugin `main` entry points in a SEPARATE Node process (Electron's
 * `utilityProcess`) — the same isolation model VSCode uses: extensions get full
 * Node, but in their own process with no direct access to the renderer DOM or
 * the main process's memory; they talk to the host only through the message
 * protocol below. A plugin's code runs only after the user enables it.
 *
 * Protocol (main ⇄ host):
 *   main → host  { type:'activate',  pluginId, mainPath }
 *   main → host  { type:'deactivate', pluginId }
 *   main → host  { type:'invoke', invocationId, command, args }
 *   host → main  { type:'registered', pluginId, commands:[id,…] }
 *   host → main  { type:'result', invocationId, ok, value?, error? }
 *   host → main  { type:'log', level, message }
 *
 * The bootstrap is written to userData at startup and forked, so no extra
 * bundler entry point is needed.
 */

import { utilityProcess, type UtilityProcess } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The child-process bootstrap (plain CJS). Loads plugin entries + routes. */
const BOOTSTRAP = String.raw`
'use strict'
const port = process.parentPort
const handlers = new Map() // command id -> fn
const active = new Map()   // pluginId -> module
function log(level, message) { try { port.postMessage({ type: 'log', level, message }) } catch {} }
function api(pluginId) {
  return {
    commands: {
      registerCommand(id, fn) {
        if (typeof id === 'string' && typeof fn === 'function') handlers.set(id, fn)
      },
    },
  }
}
async function loadModule(p) {
  try { return require(p) } catch (e) {
    try { return await import('file://' + p) } catch (e2) { throw e2 }
  }
}
port.on('message', async (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'activate') {
    try {
      const mod = await loadModule(msg.mainPath)
      active.set(msg.pluginId, mod)
      const before = new Set(handlers.keys())
      const activate = mod && (mod.activate || (mod.default && mod.default.activate))
      if (typeof activate === 'function') await activate(api(msg.pluginId))
      const added = [...handlers.keys()].filter((k) => !before.has(k))
      port.postMessage({ type: 'registered', pluginId: msg.pluginId, commands: added })
    } catch (e) {
      log('error', 'activate ' + msg.pluginId + ' failed: ' + (e && e.message || e))
    }
  } else if (msg.type === 'deactivate') {
    const mod = active.get(msg.pluginId)
    try { if (mod && typeof mod.deactivate === 'function') mod.deactivate() } catch {}
    active.delete(msg.pluginId)
  } else if (msg.type === 'invoke') {
    const fn = handlers.get(msg.command)
    if (typeof fn !== 'function') {
      port.postMessage({ type: 'result', invocationId: msg.invocationId, ok: false, error: 'no handler' })
      return
    }
    try {
      const value = await fn(...(msg.args || []))
      port.postMessage({ type: 'result', invocationId: msg.invocationId, ok: true, value })
    } catch (e) {
      port.postMessage({ type: 'result', invocationId: msg.invocationId, ok: false, error: (e && e.message) || String(e) })
    }
  }
})
`

export interface ActivatePlugin {
  pluginId: string
  /** Absolute path to the plugin's main entry. */
  mainPath: string
}

interface HostMessage {
  type: string
  pluginId?: string
  commands?: string[]
  invocationId?: number
  ok?: boolean
  value?: unknown
  error?: string
  level?: string
  message?: string
}

export class ExtHostManager {
  #proc: UtilityProcess | null = null
  #bootstrapPath: string
  #seq = 1
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  /** command id → owning plugin id. */
  #commands = new Map<string, string>()
  #active = new Set<string>()
  #onCommandsChanged: (commands: string[]) => void

  constructor(userDataPath: string, onCommandsChanged: (commands: string[]) => void) {
    this.#bootstrapPath = join(userDataPath, 'exthost-bootstrap.cjs')
    this.#onCommandsChanged = onCommandsChanged
  }

  #ensureStarted(): void {
    if (this.#proc !== null) return
    writeFileSync(this.#bootstrapPath, BOOTSTRAP, 'utf8')
    const proc = utilityProcess.fork(this.#bootstrapPath, [], {
      serviceName: 'hive-extension-host',
    })
    proc.on('message', (msg: HostMessage) => this.#onMessage(msg))
    proc.on('exit', () => {
      this.#proc = null
      this.#commands.clear()
      this.#active.clear()
      for (const p of this.#pending.values()) p.reject(new Error('exthost: exited'))
      this.#pending.clear()
    })
    this.#proc = proc
  }

  #onMessage(msg: HostMessage): void {
    if (msg.type === 'registered' && msg.pluginId && msg.commands) {
      for (const id of msg.commands) this.#commands.set(id, msg.pluginId)
      this.#onCommandsChanged([...this.#commands.keys()])
    } else if (msg.type === 'result' && typeof msg.invocationId === 'number') {
      const pending = this.#pending.get(msg.invocationId)
      if (pending) {
        this.#pending.delete(msg.invocationId)
        if (msg.ok) pending.resolve(msg.value)
        else pending.reject(new Error(msg.error ?? 'exthost: command failed'))
      }
    } else if (msg.type === 'log') {
      // eslint-disable-next-line no-console
      console[msg.level === 'error' ? 'error' : 'log'](`[exthost] ${msg.message}`)
    }
  }

  /** Activate the given plugins (with a `main`), deactivating any removed. */
  setActive(plugins: ActivatePlugin[]): void {
    if (plugins.length === 0 && this.#proc === null) return
    this.#ensureStarted()
    const want = new Set(plugins.map((p) => p.pluginId))
    // Deactivate removed.
    for (const id of [...this.#active]) {
      if (!want.has(id)) {
        this.#proc?.postMessage({ type: 'deactivate', pluginId: id })
        this.#active.delete(id)
        for (const [cmd, owner] of [...this.#commands]) {
          if (owner === id) this.#commands.delete(cmd)
        }
      }
    }
    // Activate new.
    for (const p of plugins) {
      if (this.#active.has(p.pluginId)) continue
      this.#active.add(p.pluginId)
      this.#proc?.postMessage({
        type: 'activate',
        pluginId: p.pluginId,
        mainPath: p.mainPath,
      })
    }
    this.#onCommandsChanged([...this.#commands.keys()])
  }

  /** Invoke a contributed command in the host. */
  invoke(command: string, args: unknown[]): Promise<unknown> {
    if (this.#proc === null) return Promise.reject(new Error('exthost: not running'))
    const invocationId = this.#seq++
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(invocationId, { resolve, reject })
      this.#proc?.postMessage({ type: 'invoke', invocationId, command, args })
    })
  }

  /** Currently-registered command ids. */
  commands(): string[] {
    return [...this.#commands.keys()]
  }

  dispose(): void {
    this.#proc?.kill()
    this.#proc = null
  }
}
