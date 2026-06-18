import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedBundledPlugins, markPluginUninstalled } from './seed';

let root: string;
let bundled: string;
let target: string;

async function makeBundled(id: string, version: string) {
  const folder = join(bundled, id.replaceAll('/', '-'));
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'plugin.json'),
    JSON.stringify({ id, name: id, version }),
  );
  await writeFile(join(folder, 'material-icons.json'), '{"iconDefinitions":{}}');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'seed-'));
  bundled = join(root, 'bundled');
  target = join(root, 'plugins');
  await mkdir(bundled, { recursive: true });
  await mkdir(target, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('seedBundledPlugins', () => {
  it('copies a bundled plugin when absent', async () => {
    await makeBundled('hive/material-icons', '1.0.0');
    await seedBundledPlugins({ bundledDir: bundled, pluginsDir: target });
    const m = JSON.parse(
      await readFile(join(target, 'hive-material-icons', 'plugin.json'), 'utf8'),
    );
    expect(m.id).toBe('hive/material-icons');
  });

  it('is idempotent on a second run', async () => {
    await makeBundled('hive/material-icons', '1.0.0');
    await seedBundledPlugins({ bundledDir: bundled, pluginsDir: target });
    await seedBundledPlugins({ bundledDir: bundled, pluginsDir: target });
    const entries = await readdir(join(target, 'hive-material-icons'));
    expect(entries).toContain('plugin.json');
  });

  it('does not re-seed after the user uninstalls', async () => {
    await makeBundled('hive/material-icons', '1.0.0');
    await seedBundledPlugins({ bundledDir: bundled, pluginsDir: target });
    await rm(join(target, 'hive-material-icons'), { recursive: true, force: true });
    await markPluginUninstalled(target, 'hive/material-icons');
    await seedBundledPlugins({ bundledDir: bundled, pluginsDir: target });
    await expect(
      readdir(join(target, 'hive-material-icons')),
    ).rejects.toThrow();
  });

  it('refreshes when the bundled version is newer', async () => {
    await makeBundled('hive/material-icons', '1.0.0');
    await seedBundledPlugins({ bundledDir: bundled, pluginsDir: target });
    await makeBundled('hive/material-icons', '1.1.0');
    await seedBundledPlugins({ bundledDir: bundled, pluginsDir: target });
    const m = JSON.parse(
      await readFile(join(target, 'hive-material-icons', 'plugin.json'), 'utf8'),
    );
    expect(m.version).toBe('1.1.0');
  });
});
