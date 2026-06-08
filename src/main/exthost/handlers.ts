/**
 * Extension-host IPC handlers (E10-09 / E10-03).
 *
 * Two channels reach `window.hive.exthost.*`:
 *   - exthost:set-enabled  { ids:string[] } — the renderer tells us which
 *     plugins the user has enabled; we resolve each one's `main` entry (only
 *     valid, engine-compatible plugins with a `main` are eligible) and hand the
 *     absolute paths to the host manager, which activates/deactivates to match.
 *   - exthost:invoke       { command, args } — run a contributed command in the
 *     host and return its result.
 *
 * Whenever the set of host-registered commands changes we push
 * `event:exthost:commands` so the renderer can (re)register them in the command
 * registry. The resolved `main` path is validated to live under the plugin's
 * own directory — a manifest can't point `main` at an arbitrary file.
 */

import { ipcMain, type App, type BrowserWindow } from 'electron'
import { resolve, sep } from 'node:path'

import { discoverPlugins } from '../plugins/loader'
import { pluginsDir } from '../plugins/storage'
import { ExtHostManager, type ActivatePlugin } from './host'

export const EXTHOST_CHANNELS = {
  setEnabled: 'exthost:set-enabled',
  invoke: 'exthost:invoke',
  commandsEvent: 'event:exthost:commands',
} as const

export interface ExtHostHandlersOptions {
  app: App
  hiveVersion: string
  getMainWindow: () => BrowserWindow | null
}

/** Resolve `main` to an absolute path that must stay inside `rootPath`. */
function resolveMain(rootPath: string, main: string): string | null {
  const absolute = resolve(rootPath, main)
  const guard = rootPath.endsWith(sep) ? rootPath : rootPath + sep
  if (absolute !== rootPath && !absolute.startsWith(guard)) return null
  return absolute
}

export function registerExtHostHandlers(opts: ExtHostHandlersOptions): () => void {
  const { app, hiveVersion, getMainWindow } = opts

  const manager = new ExtHostManager(app.getPath('userData'), (commands) => {
    getMainWindow()?.webContents.send(EXTHOST_CHANNELS.commandsEvent, commands)
  })

  ipcMain.handle(
    EXTHOST_CHANNELS.setEnabled,
    async (_event, raw: unknown): Promise<string[]> => {
      const ids = new Set(
        Array.isArray((raw as { ids?: unknown })?.ids)
          ? ((raw as { ids: unknown[] }).ids.filter((x) => typeof x === 'string') as string[])
          : [],
      )
      const dir = await pluginsDir(app)
      const plugins = await discoverPlugins(dir, hiveVersion)
      const active: ActivatePlugin[] = []
      for (const p of plugins) {
        if (!p.valid || !ids.has(p.manifest.id) || !p.manifest.main) continue
        const mainPath = resolveMain(p.rootPath, p.manifest.main)
        if (mainPath !== null) active.push({ pluginId: p.manifest.id, mainPath })
      }
      manager.setActive(active)
      return manager.commands()
    },
  )

  ipcMain.handle(
    EXTHOST_CHANNELS.invoke,
    async (_event, raw: unknown): Promise<unknown> => {
      const obj = (raw ?? {}) as { command?: unknown; args?: unknown }
      if (typeof obj.command !== 'string') {
        throw new TypeError('exthost:invoke requires { command: string }')
      }
      const args = Array.isArray(obj.args) ? obj.args : []
      return manager.invoke(obj.command, args)
    },
  )

  return () => {
    ipcMain.removeHandler(EXTHOST_CHANNELS.setEnabled)
    ipcMain.removeHandler(EXTHOST_CHANNELS.invoke)
    manager.dispose()
  }
}
