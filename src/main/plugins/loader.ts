/**
 * Plugin discovery + validation — REQ-006.
 *
 * Pure(ish) module: takes a plugins directory + the host's Hive version,
 * walks the directory once, reads + validates each subdirectory's
 * `plugin.json`, and returns a `LoadedPlugin[]` snapshot.
 *
 * Validation is deliberately strict — a malformed manifest yields a
 * `LoadedPlugin` with `valid=false` and an `invalidReason`, never a
 * crash. The Plugins view shows the reason so the user knows what to
 * fix; the runtime simply skips the contributions when activating.
 *
 * Path safety: `readPluginAsset` resolves the requested relative path
 * against the plugin's root and rejects anything that would escape it.
 * This is the renderer's only path into a plugin's bundled files (Monaco
 * `LanguageConfiguration` / Monarch `grammar`), so the check has to live
 * here — the renderer is untrusted at the IPC boundary.
 */

import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import semver from 'semver';

import type {
  LoadedPlugin,
  PluginCommandContribution,
  PluginConfigProperty,
  PluginConfigurationContribution,
  PluginDebuggerContribution,
  PluginKeybindingContribution,
  PluginLanguageContribution,
  PluginLanguageServerContribution,
  PluginManifest,
  PluginSetupDownload,
  PluginThemeContribution,
} from '../../types/workspace';

/** Manifest filename inside every plugin folder. */
const MANIFEST_FILENAME = 'plugin.json';

/** Pattern an id must match — `<publisher>/<name>`, kebab-cased. */
const ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/i;

/**
 * Walk `pluginsDir` once and return every subdirectory's load result.
 *
 * Missing directory → `[]` (fresh install). A subdirectory that lacks a
 * `plugin.json` is silently skipped — it isn't a plugin. Anything that
 * looks like a plugin but fails validation comes back with `valid=false`.
 */
export async function discoverPlugins(
  pluginsDir: string,
  hiveVersion: string,
): Promise<LoadedPlugin[]> {
  const entries = await safeReaddir(pluginsDir);
  const results: LoadedPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const rootPath = join(pluginsDir, entry.name);
    const loaded = await loadPlugin(rootPath, hiveVersion);
    if (loaded !== null) results.push(loaded);
  }

  return results;
}

/**
 * Load a single plugin from its root folder.
 *
 * Returns `null` only when the folder has no `plugin.json` at all (i.e.
 * it isn't a plugin). Every other failure mode produces a `LoadedPlugin`
 * with `valid=false` and an `invalidReason`.
 *
 * Exported so the installer can validate a folder *before* copying it,
 * and so REQ-007 can re-load a single plugin without re-walking the dir.
 */
export async function loadPlugin(
  rootPath: string,
  hiveVersion: string,
): Promise<LoadedPlugin | null> {
  const manifestPath = join(rootPath, MANIFEST_FILENAME);

  let rawText: string;
  try {
    rawText = await fs.readFile(manifestPath, 'utf8');
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    return invalidLoad(rootPath, `Failed to read plugin.json: ${errorMessage(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: unknown) {
    return invalidLoad(rootPath, `plugin.json is not valid JSON: ${errorMessage(err)}`);
  }

  const validated = validateManifest(parsed);
  if (!validated.ok) {
    // Even on a structural failure we want *some* manifest shape on the
    // result so the Plugins view has a name to render. Fall back to a
    // minimal stub.
    return {
      manifest: stubManifest(parsed),
      rootPath,
      valid: false,
      invalidReason: validated.reason,
    };
  }

  const manifest = validated.manifest;
  const engineCheck = checkEngine(manifest, hiveVersion);
  if (engineCheck !== null) {
    return {
      manifest,
      rootPath,
      valid: false,
      invalidReason: engineCheck,
    };
  }

  return { manifest, rootPath, valid: true };
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

interface ValidationOk {
  ok: true;
  manifest: PluginManifest;
}

interface ValidationFail {
  ok: false;
  reason: string;
}

type ValidationResult = ValidationOk | ValidationFail;

/**
 * Coerce arbitrary parsed JSON into a {@link PluginManifest}, enforcing
 * the rules from the REQ-006 spec:
 *
 *   - id is non-empty + matches `<pub>/<name>` slug regex
 *   - name + version required
 *   - version is valid semver
 *   - engines.hive (if present) is a valid semver range
 *
 * Unknown extra fields are ignored — manifest forward-compatibility.
 */
export function validateManifest(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'plugin.json must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    return { ok: false, reason: 'manifest.id is required (string)' };
  }
  if (!ID_PATTERN.test(obj.id)) {
    return {
      ok: false,
      reason: `manifest.id "${obj.id}" must match <publisher>/<name> (kebab-case)`,
    };
  }

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return { ok: false, reason: 'manifest.name is required (string)' };
  }

  if (typeof obj.version !== 'string' || obj.version.length === 0) {
    return { ok: false, reason: 'manifest.version is required (string)' };
  }
  if (semver.valid(obj.version) === null) {
    return {
      ok: false,
      reason: `manifest.version "${obj.version}" is not valid semver`,
    };
  }

  const description =
    typeof obj.description === 'string' ? obj.description : undefined;
  const publisher =
    typeof obj.publisher === 'string' ? obj.publisher : undefined;

  // engines
  let engines: PluginManifest['engines'];
  if (obj.engines !== undefined) {
    if (typeof obj.engines !== 'object' || obj.engines === null) {
      return { ok: false, reason: 'manifest.engines must be an object' };
    }
    const e = obj.engines as Record<string, unknown>;
    if (e.hive !== undefined) {
      if (typeof e.hive !== 'string' || semver.validRange(e.hive) === null) {
        return {
          ok: false,
          reason: `manifest.engines.hive "${String(e.hive)}" is not a valid semver range`,
        };
      }
      engines = { hive: e.hive };
    }
  }

  // contributes
  let contributes: PluginManifest['contributes'];
  if (obj.contributes !== undefined) {
    if (typeof obj.contributes !== 'object' || obj.contributes === null) {
      return { ok: false, reason: 'manifest.contributes must be an object' };
    }
    const c = obj.contributes as Record<string, unknown>;
    const languages = parseLanguages(c.languages);
    if (languages !== null && !languages.ok) {
      return { ok: false, reason: languages.reason };
    }
    const languageServers = parseLanguageServers(c.languageServers);
    if (languageServers !== null && !languageServers.ok) {
      return { ok: false, reason: languageServers.reason };
    }
    contributes = {
      languages: languages?.value,
      languageServers: languageServers?.value,
      keybindings: parseKeybindings(c.keybindings),
      debuggers: parseDebuggers(c.debuggers),
      configuration: parseConfiguration(c.configuration),
      themes: parseThemes(c.themes),
      commands: parseCommands(c.commands),
    };
  }

  // setup (REQ-007)
  let setup: PluginManifest['setup'];
  if (obj.setup !== undefined) {
    if (typeof obj.setup !== 'object' || obj.setup === null) {
      return { ok: false, reason: 'manifest.setup must be an object' };
    }
    const s = obj.setup as Record<string, unknown>;
    const downloads = parseSetupDownloads(s.downloads);
    if (downloads !== null && !downloads.ok) {
      return { ok: false, reason: downloads.reason };
    }
    setup = { downloads: downloads?.value };
  }

  // dependencies (E10-08) — lenient: keep only string ids.
  const dependencies = Array.isArray(obj.dependencies)
    ? obj.dependencies.filter((d): d is string => typeof d === 'string')
    : undefined;
  // main entry (E10-09) — relative module path run in the extension host.
  const main = typeof obj.main === 'string' && obj.main.length > 0 ? obj.main : undefined;

  return {
    ok: true,
    manifest: {
      id: obj.id,
      name: obj.name,
      version: obj.version,
      description,
      publisher,
      engines,
      dependencies: dependencies && dependencies.length > 0 ? dependencies : undefined,
      main,
      contributes,
      setup,
    },
  };
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Lenient parser for contributes.keybindings (E10-04). Malformed entries are
 * dropped rather than invalidating the whole plugin — a bad binding should not
 * disable a language server. Returns undefined when none are valid.
 */
function parseKeybindings(
  raw: unknown,
): PluginKeybindingContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginKeybindingContribution[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.command !== 'string' || typeof e.key !== 'string') continue;
    if (e.command.length === 0 || e.key.length === 0) continue;
    out.push({
      command: e.command,
      key: e.key,
      mac: typeof e.mac === 'string' ? e.mac : undefined,
      when: typeof e.when === 'string' ? e.when : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Lenient parser for contributes.commands (E10-03). Each needs a `command` id
 * and a `title`; malformed entries are dropped. The handler is wired at runtime
 * by the extension host once the plugin's `main` registers it.
 */
function parseCommands(
  raw: unknown,
): PluginCommandContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginCommandContribution[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.command !== 'string' || e.command.length === 0) continue;
    if (typeof e.title !== 'string' || e.title.length === 0) continue;
    out.push({
      command: e.command,
      title: e.title,
      category: typeof e.category === 'string' ? e.category : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Lenient parser for contributes.configuration (E10-05). */
function parseConfiguration(
  raw: unknown,
): PluginConfigurationContribution | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const propsRaw = obj.properties;
  if (typeof propsRaw !== 'object' || propsRaw === null) return undefined;
  const properties: Record<string, PluginConfigProperty> = {};
  for (const [key, val] of Object.entries(propsRaw as Record<string, unknown>)) {
    if (typeof val !== 'object' || val === null) continue;
    const p = val as Record<string, unknown>;
    const type = p.type;
    if (
      type !== 'boolean' &&
      type !== 'number' &&
      type !== 'string' &&
      type !== 'string[]'
    ) {
      continue;
    }
    properties[key] = {
      type,
      default: p.default,
      description: typeof p.description === 'string' ? p.description : undefined,
      enum: Array.isArray(p.enum)
        ? p.enum.filter((e): e is string => typeof e === 'string')
        : undefined,
    };
  }
  if (Object.keys(properties).length === 0) return undefined;
  return {
    title: typeof obj.title === 'string' ? obj.title : undefined,
    properties,
  };
}

/** Lenient parser for contributes.themes (E10-07 / E8-04). */
function parseThemes(raw: unknown): PluginThemeContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginThemeContribution[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.label !== 'string') continue;
    const type = e.type === 'light' ? 'light' : e.type === 'hc' ? 'hc' : 'dark';
    let colors: Record<string, string> | undefined;
    if (typeof e.colors === 'object' && e.colors !== null) {
      colors = {};
      for (const [k, v] of Object.entries(e.colors as Record<string, unknown>)) {
        if (typeof v === 'string') colors[k] = v;
      }
    }
    out.push({ id: e.id, label: e.label, type, colors });
  }
  return out.length > 0 ? out : undefined;
}

/** Lenient parser for contributes.debuggers (E3-12 / E10-06). */
function parseDebuggers(
  raw: unknown,
): PluginDebuggerContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginDebuggerContribution[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || typeof e.program !== 'string') continue;
    out.push({
      type: e.type,
      program: e.program,
      label: typeof e.label === 'string' ? e.label : undefined,
      runtime: typeof e.runtime === 'string' ? e.runtime : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseLanguages(
  raw: unknown,
): ParseResult<PluginLanguageContribution[]> | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'contributes.languages must be an array' };
  }
  const out: PluginLanguageContribution[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, reason: 'contributes.languages entries must be objects' };
    }
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id.length === 0) {
      return {
        ok: false,
        reason: 'contributes.languages[].id is required (string)',
      };
    }
    const entry: PluginLanguageContribution = { id: e.id };
    if (e.extensions !== undefined) {
      if (!Array.isArray(e.extensions) || !e.extensions.every((s) => typeof s === 'string')) {
        return {
          ok: false,
          reason: 'contributes.languages[].extensions must be an array of strings',
        };
      }
      entry.extensions = e.extensions as string[];
    }
    if (e.aliases !== undefined) {
      if (!Array.isArray(e.aliases) || !e.aliases.every((s) => typeof s === 'string')) {
        return {
          ok: false,
          reason: 'contributes.languages[].aliases must be an array of strings',
        };
      }
      entry.aliases = e.aliases as string[];
    }
    if (e.configuration !== undefined) {
      if (typeof e.configuration !== 'string') {
        return {
          ok: false,
          reason: 'contributes.languages[].configuration must be a string',
        };
      }
      entry.configuration = e.configuration;
    }
    if (e.grammar !== undefined) {
      if (typeof e.grammar !== 'string') {
        return {
          ok: false,
          reason: 'contributes.languages[].grammar must be a string',
        };
      }
      entry.grammar = e.grammar;
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

function parseLanguageServers(
  raw: unknown,
): ParseResult<PluginLanguageServerContribution[]> | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'contributes.languageServers must be an array' };
  }
  const out: PluginLanguageServerContribution[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return {
        ok: false,
        reason: 'contributes.languageServers entries must be objects',
      };
    }
    const e = item as Record<string, unknown>;
    if (typeof e.language !== 'string' || e.language.length === 0) {
      return {
        ok: false,
        reason: 'contributes.languageServers[].language is required (string)',
      };
    }
    if (typeof e.command !== 'string' || e.command.length === 0) {
      return {
        ok: false,
        reason: 'contributes.languageServers[].command is required (string)',
      };
    }
    const entry: PluginLanguageServerContribution = {
      language: e.language,
      command: e.command,
    };
    if (e.args !== undefined) {
      if (!Array.isArray(e.args) || !e.args.every((s) => typeof s === 'string')) {
        return {
          ok: false,
          reason: 'contributes.languageServers[].args must be an array of strings',
        };
      }
      entry.args = e.args as string[];
    }
    if (e.transport !== undefined) {
      if (e.transport !== 'stdio' && e.transport !== 'socket') {
        return {
          ok: false,
          reason: 'contributes.languageServers[].transport must be "stdio" or "socket"',
        };
      }
      entry.transport = e.transport;
    }
    if (e.initializationOptions !== undefined) {
      // Opaque JSON — pass through verbatim. Plugin authors own its shape.
      entry.initializationOptions = e.initializationOptions;
    }
    if (e.cwd !== undefined) {
      if (typeof e.cwd !== 'string' || e.cwd.length === 0) {
        return {
          ok: false,
          reason: 'contributes.languageServers[].cwd must be a non-empty string',
        };
      }
      entry.cwd = e.cwd;
    }
    if (e.env !== undefined) {
      if (typeof e.env !== 'object' || e.env === null || Array.isArray(e.env)) {
        return {
          ok: false,
          reason: 'contributes.languageServers[].env must be an object of string values',
        };
      }
      const envObj = e.env as Record<string, unknown>;
      const env: Record<string, string> = {};
      for (const k of Object.keys(envObj)) {
        const v = envObj[k];
        if (typeof v !== 'string') {
          return {
            ok: false,
            reason: `contributes.languageServers[].env[${k}] must be a string`,
          };
        }
        env[k] = v;
      }
      entry.env = env;
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

function parseSetupDownloads(
  raw: unknown,
): ParseResult<PluginSetupDownload[]> | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'setup.downloads must be an array' };
  }
  const out: PluginSetupDownload[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, reason: 'setup.downloads entries must be objects' };
    }
    const e = item as Record<string, unknown>;
    if (typeof e.url !== 'string' || e.url.length === 0) {
      return { ok: false, reason: 'setup.downloads[].url is required (string)' };
    }
    if (!e.url.startsWith('https://')) {
      return { ok: false, reason: 'setup.downloads[].url must be https://' };
    }
    if (typeof e.extractTo !== 'string' || e.extractTo.length === 0) {
      return {
        ok: false,
        reason: 'setup.downloads[].extractTo is required (string)',
      };
    }
    const entry: PluginSetupDownload = { url: e.url, extractTo: e.extractTo };
    if (e.sha256 !== undefined) {
      if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(e.sha256)) {
        return {
          ok: false,
          reason: 'setup.downloads[].sha256 must be a 64-char hex string',
        };
      }
      entry.sha256 = e.sha256.toLowerCase();
    }
    if (e.archive !== undefined) {
      if (e.archive !== 'tar.gz' && e.archive !== 'zip' && e.archive !== 'none') {
        return {
          ok: false,
          reason: 'setup.downloads[].archive must be "tar.gz", "zip", or "none"',
        };
      }
      entry.archive = e.archive;
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

/**
 * Compare a manifest's `engines.hive` range against the host version.
 * Returns `null` when satisfied (or absent), otherwise a reason string.
 */
function checkEngine(
  manifest: PluginManifest,
  hiveVersion: string,
): string | null {
  const range = manifest.engines?.hive;
  if (range === undefined) return null;
  // `includePrerelease: true` — early hive versions ship as `0.1.0-...`,
  // which strict semver would otherwise refuse to satisfy `^0.1.0`.
  if (!semver.satisfies(hiveVersion, range, { includePrerelease: true })) {
    return `Requires hive ${range} but host is ${hiveVersion}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Asset reading (path-safe)
// ---------------------------------------------------------------------------

/**
 * Read a plugin-relative file as UTF-8.
 *
 * Renderer-facing — `relPath` arrives over IPC. We resolve it against
 * `rootPath`, then verify the resolved absolute path still lives under
 * `rootPath` so a `../../etc/passwd` can't trick us into reading outside
 * the plugin folder. The check is suffix-aware (`rootPath + sep`) so a
 * sibling like `<root>-evil/foo` is also rejected.
 */
export async function readPluginAsset(
  rootPath: string,
  relPath: string,
): Promise<string> {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new TypeError('readPluginAsset: relPath must be a non-empty string');
  }
  if (relPath.includes('\0')) {
    throw new Error('readPluginAsset: relPath contains null byte');
  }
  const absolute = resolve(rootPath, relPath);
  const guard = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  if (absolute !== rootPath && !absolute.startsWith(guard)) {
    throw new Error(
      `readPluginAsset: relPath escapes plugin root: ${relPath}`,
    );
  }
  return fs.readFile(absolute, 'utf8');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function safeReaddir(dir: string): Promise<Array<{ name: string; isDirectory: () => boolean }>> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Build a minimal manifest stub from arbitrary parsed JSON so an invalid
 * plugin still has something to render in the Plugins view.
 */
function stubManifest(raw: unknown): PluginManifest {
  if (typeof raw !== 'object' || raw === null) {
    return { id: 'unknown/unknown', name: 'Invalid plugin', version: '0.0.0' };
  }
  const obj = raw as Record<string, unknown>;
  return {
    id: typeof obj.id === 'string' ? obj.id : 'unknown/unknown',
    name: typeof obj.name === 'string' ? obj.name : 'Invalid plugin',
    version: typeof obj.version === 'string' ? obj.version : '0.0.0',
    description: typeof obj.description === 'string' ? obj.description : undefined,
    publisher: typeof obj.publisher === 'string' ? obj.publisher : undefined,
  };
}

function invalidLoad(rootPath: string, reason: string): LoadedPlugin {
  return {
    manifest: { id: 'unknown/unknown', name: 'Invalid plugin', version: '0.0.0' },
    rootPath,
    valid: false,
    invalidReason: reason,
  };
}
