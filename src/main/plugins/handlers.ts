/**
 * Plugin IPC handlers — REQ-006.
 *
 * Wires five `plugins:*` channels the renderer reaches via
 * `window.hive.plugins.*`. Same slice shape as the other handlers under
 * src/main/{fs,project,shell,terminal}/handlers.ts:
 *
 *   - module-scoped channel constants
 *   - one `registerPluginHandlers` entry point that returns a teardown
 *     closure removing the IPC registrations
 *   - all paths through the storage / loader / install modules so the
 *     trust boundary lives in one place
 */

import { ipcMain, type App, type BrowserWindow } from 'electron';

import type { LoadedPlugin } from '../../types/workspace';
import {
  installFromGithub,
  installLocal,
  uninstall,
  type GithubInstallOptions,
} from './install';
import { discoverPlugins, loadPlugin, readPluginAsset } from './loader';
import { pluginDirFor, pluginsDir } from './storage';
import { parseRegistry, type RegistryPlugin } from './registry';

export const PLUGIN_CHANNELS = {
  list: 'plugins:list',
  installLocal: 'plugins:install-local',
  installGithub: 'plugins:install-github',
  uninstall: 'plugins:uninstall',
  readAsset: 'plugins:read-asset',
  registryFetch: 'plugins:registry-fetch',
  registryReadme: 'plugins:registry-readme',
} as const;

/** Only https registry/readme URLs are fetched — never file:// or app schemes. */
function assertHttps(url: unknown): string {
  if (typeof url !== 'string') throw new TypeError('registry: url must be a string');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`registry: invalid url ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`registry: only https is allowed (got ${parsed.protocol})`);
  }
  return url;
}

export interface PluginHandlersOptions {
  app: App;
  /** Host version — compared against each manifest's `engines.hive`. */
  hiveVersion: string;
  /**
   * Resolve the currently active renderer window. Not used in REQ-006
   * (the install paths don't push events) but kept on the surface so
   * REQ-007's LSP runner can push diagnostics back through the same
   * registration without reshaping this options struct.
   */
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Register the five `plugins:*` IPC handlers. Returns a teardown closure
 * that removes every registration — call it from `before-quit`.
 */
export function registerPluginHandlers(
  opts: PluginHandlersOptions,
): () => void {
  const { app, hiveVersion } = opts;

  ipcMain.handle(PLUGIN_CHANNELS.list, async (): Promise<LoadedPlugin[]> => {
    const dir = await pluginsDir(app);
    return discoverPlugins(dir, hiveVersion);
  });

  ipcMain.handle(
    PLUGIN_CHANNELS.installLocal,
    async (_event, raw: unknown): Promise<LoadedPlugin> => {
      const path = assertPathPayload(raw);
      const dir = await pluginsDir(app);
      return installLocal(path, dir, hiveVersion);
    },
  );

  ipcMain.handle(
    PLUGIN_CHANNELS.installGithub,
    async (_event, raw: unknown): Promise<LoadedPlugin> => {
      const ghOpts = assertGithubPayload(raw);
      const dir = await pluginsDir(app);
      return installFromGithub(ghOpts, dir, hiveVersion);
    },
  );

  ipcMain.handle(
    PLUGIN_CHANNELS.uninstall,
    async (_event, raw: unknown): Promise<void> => {
      const id = assertIdPayload(raw);
      const dir = pluginDirFor(app, id);
      await uninstall(dir);
    },
  );

  ipcMain.handle(
    PLUGIN_CHANNELS.readAsset,
    async (_event, raw: unknown): Promise<string> => {
      const { id, relPath } = assertReadAssetPayload(raw);
      const root = pluginDirFor(app, id);
      // Confirm the plugin exists + has a manifest at the expected path
      // before serving assets; otherwise a renderer could probe arbitrary
      // ids to test for installed plugins. (The error path is the same,
      // so the leak is minimal — still cheaper to fail fast.)
      const loaded = await loadPlugin(root, hiveVersion);
      if (loaded === null) {
        throw new Error(`plugins:read-asset: plugin "${id}" is not installed`);
      }
      return readPluginAsset(root, relPath);
    },
  );

  // ----- E10-01 marketplace -------------------------------------------
  ipcMain.handle(
    PLUGIN_CHANNELS.registryFetch,
    async (_event, raw: unknown): Promise<RegistryPlugin[]> => {
      const url = assertHttps((raw as { url?: unknown })?.url);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`registry: HTTP ${res.status}`);
      return parseRegistry(await res.json());
    },
  );
  ipcMain.handle(
    PLUGIN_CHANNELS.registryReadme,
    async (_event, raw: unknown): Promise<string> => {
      const url = assertHttps((raw as { url?: unknown })?.url);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`registry: HTTP ${res.status}`);
      return res.text();
    },
  );

  return () => {
    ipcMain.removeHandler(PLUGIN_CHANNELS.list);
    ipcMain.removeHandler(PLUGIN_CHANNELS.installLocal);
    ipcMain.removeHandler(PLUGIN_CHANNELS.installGithub);
    ipcMain.removeHandler(PLUGIN_CHANNELS.uninstall);
    ipcMain.removeHandler(PLUGIN_CHANNELS.readAsset);
    ipcMain.removeHandler(PLUGIN_CHANNELS.registryFetch);
    ipcMain.removeHandler(PLUGIN_CHANNELS.registryReadme);
  };
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function assertPathPayload(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.path === 'string' && obj.path.length > 0) return obj.path;
  }
  throw new TypeError(
    'plugins:install-local requires { path: string }',
  );
}

function assertGithubPayload(raw: unknown): GithubInstallOptions {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError(
      'plugins:install-github requires an object payload',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.owner !== 'string' || obj.owner.length === 0) {
    throw new TypeError('plugins:install-github: owner is required');
  }
  if (typeof obj.repo !== 'string' || obj.repo.length === 0) {
    throw new TypeError('plugins:install-github: repo is required');
  }
  const tag = typeof obj.tag === 'string' && obj.tag.length > 0 ? obj.tag : undefined;
  return { owner: obj.owner, repo: obj.repo, tag };
}

function assertIdPayload(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
  }
  throw new TypeError('plugins:uninstall requires { id: string }');
}

function assertReadAssetPayload(raw: unknown): { id: string; relPath: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError(
      'plugins:read-asset requires { id, relPath } payload',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    throw new TypeError('plugins:read-asset: id is required (string)');
  }
  if (typeof obj.relPath !== 'string' || obj.relPath.length === 0) {
    throw new TypeError('plugins:read-asset: relPath is required (string)');
  }
  return { id: obj.id, relPath: obj.relPath };
}
