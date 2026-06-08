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

/** Hard ceilings for the marketplace fetches (DoS guard). */
const REGISTRY_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const REGISTRY_TIMEOUT_MS = 10_000;

/**
 * Validate a marketplace URL: https only, and never a private / loopback /
 * link-local target. `readmeUrl` comes from the (untrusted) registry document,
 * so this is the SSRF gate — block obvious internal hosts by literal address
 * or hostname so a malicious index can't probe the user's LAN.
 */
function assertSafeUrl(url: unknown): string {
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
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`registry: refusing private/loopback host ${parsed.hostname}`);
  }
  return url;
}

/** Block loopback, link-local, RFC1918/6598 IPv4, IPv6 ULA/loopback, and
 *  local-only hostnames. Hostname-literal + IP-literal checks (defence in
 *  depth; not a substitute for DNS-resolution pinning, which is overkill for a
 *  desktop IDE's user-configured registry). */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  // IPv4 literal ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true; // loopback / RFC1918 / this-host
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 CGNAT
  }
  // IPv6 loopback / ULA / link-local.
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) {
    return true;
  }
  return false;
}

/**
 * Fetch text with: a timeout, refusal to follow redirects (a redirect could
 * downgrade scheme or hop to an internal host past the URL check), and a hard
 * byte ceiling streamed off the body (no unbounded `.text()`/`.json()`).
 */
async function safeFetchText(rawUrl: unknown): Promise<string> {
  const url = assertSafeUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'error', signal: controller.signal });
    if (!res.ok) throw new Error(`registry: HTTP ${res.status}`);
    const body = res.body;
    if (body === null) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.length;
        if (received > REGISTRY_MAX_BYTES) {
          await reader.cancel();
          throw new Error('registry: response exceeds size limit');
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
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
      const text = await safeFetchText((raw as { url?: unknown })?.url);
      return parseRegistry(JSON.parse(text));
    },
  );
  ipcMain.handle(
    PLUGIN_CHANNELS.registryReadme,
    async (_event, raw: unknown): Promise<string> =>
      safeFetchText((raw as { url?: unknown })?.url),
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
