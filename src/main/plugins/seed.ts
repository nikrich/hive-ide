/**
 * First-run seeding of bundled plugins. The app ships first-party plugins
 * (e.g. the Material icon theme) under `resources/plugins/`; on boot we copy
 * each into the user's plugins dir if it isn't there. A `.seeded.json` ledger
 * records the seeded version per id and remembers user uninstalls so we never
 * resurrect a plugin the user removed.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';

interface Ledger {
  /** id → version we last seeded. */
  seeded: Record<string, string>;
  /** ids the user uninstalled — never re-seed these. */
  uninstalled: string[];
}

const LEDGER_NAME = '.seeded.json';

async function readLedger(pluginsDir: string): Promise<Ledger> {
  try {
    const text = await fs.readFile(join(pluginsDir, LEDGER_NAME), 'utf8');
    const raw = JSON.parse(text) as Partial<Ledger>;
    return {
      seeded: raw.seeded ?? {},
      uninstalled: Array.isArray(raw.uninstalled) ? raw.uninstalled : [],
    };
  } catch {
    return { seeded: {}, uninstalled: [] };
  }
}

async function writeLedger(pluginsDir: string, ledger: Ledger): Promise<void> {
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(
    join(pluginsDir, LEDGER_NAME),
    JSON.stringify(ledger, null, 2),
    'utf8',
  );
}

/**
 * True if bundled version `a` is newer than installed version `b`. Uses
 * semver (coercing loose values) so prerelease/build suffixes compare
 * correctly; falls back to "newer" only on a clean greater-than.
 */
function isNewer(a: string, b: string): boolean {
  const va = semver.valid(a) ?? semver.coerce(a)?.version;
  const vb = semver.valid(b) ?? semver.coerce(b)?.version;
  if (va === undefined || vb === undefined || vb === null || va === null) {
    return a !== b; // unparseable: refresh only if the strings differ
  }
  return semver.gt(va, vb);
}

function folderNameFor(id: string): string {
  return id.replaceAll('/', '-');
}

export interface SeedOptions {
  /** Directory containing bundled plugin folders (each with a plugin.json). */
  bundledDir: string;
  /** The user's plugins directory (under userData). */
  pluginsDir: string;
}

/** Record that the user uninstalled `id` so the next boot won't re-seed it. */
export async function markPluginUninstalled(
  pluginsDir: string,
  id: string,
): Promise<void> {
  const ledger = await readLedger(pluginsDir);
  if (!ledger.uninstalled.includes(id)) ledger.uninstalled.push(id);
  delete ledger.seeded[id];
  await writeLedger(pluginsDir, ledger);
}

/** Copy bundled first-party plugins into the user plugins dir as needed. */
export async function seedBundledPlugins(opts: SeedOptions): Promise<void> {
  const { bundledDir, pluginsDir } = opts;
  let folders: string[];
  try {
    folders = await fs.readdir(bundledDir);
  } catch {
    return; // nothing bundled (e.g. dev without generated assets)
  }

  const ledger = await readLedger(pluginsDir);
  await fs.mkdir(pluginsDir, { recursive: true });

  for (const folder of folders) {
    const src = join(bundledDir, folder);
    let manifest: { id?: string; version?: string };
    try {
      manifest = JSON.parse(await fs.readFile(join(src, 'plugin.json'), 'utf8'));
    } catch {
      continue; // not a plugin folder
    }
    const id = manifest.id;
    const version = manifest.version ?? '0.0.0';
    if (typeof id !== 'string') continue;
    if (ledger.uninstalled.includes(id)) continue;

    const dest = join(pluginsDir, folderNameFor(id));
    const installedVersion = ledger.seeded[id];
    const present = await fs
      .stat(dest)
      .then((s) => s.isDirectory())
      .catch(() => false);

    const needsCopy =
      !present ||
      installedVersion === undefined ||
      isNewer(version, installedVersion);
    if (!needsCopy) continue;

    await fs.rm(dest, { recursive: true, force: true });
    await fs.cp(src, dest, { recursive: true });
    ledger.seeded[id] = version;
  }

  await writeLedger(pluginsDir, ledger);
}
