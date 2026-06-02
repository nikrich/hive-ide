/**
 * Plugin loader tests — REQ-006.
 *
 * Covers:
 *
 *   - manifest validation (id pattern, missing fields, bad semver,
 *     engine range mismatch / satisfied)
 *   - discovery against a mock-fs plugins directory
 *   - `readPluginAsset` path-traversal guard
 */

import { afterEach, describe, expect, it } from 'vitest';
import mockFs from 'mock-fs';

import {
  discoverPlugins,
  loadPlugin,
  readPluginAsset,
  validateManifest,
} from './loader';

const PLUGINS_DIR = '/Users/test/Library/Application Support/Hive IDE/plugins';

afterEach(() => {
  mockFs.restore();
});

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const result = validateManifest({
      id: 'hive-ide/example',
      name: 'Example',
      version: '0.1.0',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe('hive-ide/example');
    }
  });

  it('rejects a non-object manifest', () => {
    const result = validateManifest(null);
    expect(result.ok).toBe(false);
  });

  it('rejects a missing id', () => {
    const result = validateManifest({ name: 'X', version: '1.0.0' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/manifest\.id/);
  });

  it('rejects an id that does not match <publisher>/<name>', () => {
    const result = validateManifest({
      id: 'no-slash',
      name: 'X',
      version: '1.0.0',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/publisher>\/<name/);
  });

  it('rejects a missing name', () => {
    const result = validateManifest({ id: 'p/x', version: '1.0.0' });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing version', () => {
    const result = validateManifest({ id: 'p/x', name: 'X' });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-semver version', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: 'not-a-version',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/semver/);
  });

  it('rejects an invalid engines.hive range', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: '1.0.0',
      engines: { hive: 'definitely-not-a-range' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/engines\.hive/);
  });

  it('accepts contributes.languages', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: '1.0.0',
      contributes: {
        languages: [
          {
            id: 'foo',
            extensions: ['.foo'],
            aliases: ['Foo'],
            configuration: './lc.json',
            grammar: './g.json',
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.contributes?.languages?.[0].extensions).toEqual([
        '.foo',
      ]);
    }
  });

  it('rejects contributes.languages with bad extension type', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: '1.0.0',
      contributes: { languages: [{ id: 'foo', extensions: ['.foo', 7] }] },
    });
    expect(result.ok).toBe(false);
  });

  // REQ-007 — language-server + setup parsing
  it('accepts contributes.languageServers with REQ-007 fields', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: '1.0.0',
      contributes: {
        languageServers: [
          {
            language: 'java',
            command: '${pluginDir}/launch.sh',
            args: ['-data', '/tmp/jdtls'],
            transport: 'stdio',
            initializationOptions: { jvmArgs: ['-Xmx2G'] },
            cwd: '${pluginDir}',
            env: { JAVA_HOME: '/opt/jdk' },
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const server = result.manifest.contributes?.languageServers?.[0];
      expect(server?.initializationOptions).toEqual({ jvmArgs: ['-Xmx2G'] });
      expect(server?.cwd).toBe('${pluginDir}');
      expect(server?.env?.JAVA_HOME).toBe('/opt/jdk');
    }
  });

  it('rejects contributes.languageServers env with non-string value', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: '1.0.0',
      contributes: {
        languageServers: [
          { language: 'java', command: 'java', env: { N: 1 } },
        ],
      },
    });
    expect(result.ok).toBe(false);
  });

  it('accepts setup.downloads with all REQ-007 fields', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: '1.0.0',
      setup: {
        downloads: [
          {
            url: 'https://example.com/jdtls.tar.gz',
            extractTo: 'bin/jdtls',
            sha256: 'a'.repeat(64),
            archive: 'tar.gz',
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const dl = result.manifest.setup?.downloads?.[0];
      expect(dl?.url).toBe('https://example.com/jdtls.tar.gz');
      expect(dl?.archive).toBe('tar.gz');
      expect(dl?.sha256).toBe('a'.repeat(64));
    }
  });

  it('rejects setup.downloads with non-https url', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: '1.0.0',
      setup: {
        downloads: [{ url: 'http://example.com/x.tar.gz', extractTo: 'bin' }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/https/);
  });

  it('rejects setup.downloads with malformed sha256', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: '1.0.0',
      setup: {
        downloads: [
          { url: 'https://example.com/x.tar.gz', extractTo: 'bin', sha256: 'short' },
        ],
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects setup.downloads with unsupported archive kind', () => {
    const result = validateManifest({
      id: 'p/x',
      name: 'X',
      version: '1.0.0',
      setup: {
        downloads: [
          {
            url: 'https://example.com/x.tar.gz',
            extractTo: 'bin',
            archive: 'rar',
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadPlugin / discoverPlugins
// ---------------------------------------------------------------------------

describe('discoverPlugins', () => {
  it('returns [] when the plugins directory does not exist', async () => {
    mockFs({});
    const result = await discoverPlugins('/no/such/dir', '0.1.0');
    expect(result).toEqual([]);
  });

  it('skips subdirectories that lack a plugin.json', async () => {
    mockFs({
      [PLUGINS_DIR]: {
        'not-a-plugin': { 'README.md': '# nope' },
      },
    });
    const result = await discoverPlugins(PLUGINS_DIR, '0.1.0');
    expect(result).toEqual([]);
  });

  it('discovers a valid plugin', async () => {
    mockFs({
      [PLUGINS_DIR]: {
        'hive-ide-example': {
          'plugin.json': JSON.stringify({
            id: 'hive-ide/example',
            name: 'Example',
            version: '0.1.0',
          }),
        },
      },
    });
    const result = await discoverPlugins(PLUGINS_DIR, '0.1.0');
    expect(result).toHaveLength(1);
    expect(result[0].valid).toBe(true);
    expect(result[0].manifest.id).toBe('hive-ide/example');
  });

  it('marks engine-mismatch plugins as invalid with reason', async () => {
    mockFs({
      [PLUGINS_DIR]: {
        'p': {
          'plugin.json': JSON.stringify({
            id: 'pub/p',
            name: 'P',
            version: '0.1.0',
            engines: { hive: '^99.0.0' },
          }),
        },
      },
    });
    const result = await discoverPlugins(PLUGINS_DIR, '0.1.0');
    expect(result).toHaveLength(1);
    expect(result[0].valid).toBe(false);
    expect(result[0].invalidReason).toMatch(/Requires hive/);
  });

  it('returns invalid with reason when plugin.json is malformed JSON', async () => {
    mockFs({
      [PLUGINS_DIR]: {
        'broken': { 'plugin.json': 'not json' },
      },
    });
    const result = await discoverPlugins(PLUGINS_DIR, '0.1.0');
    expect(result).toHaveLength(1);
    expect(result[0].valid).toBe(false);
  });

  it('satisfies ^0.1.0 with 0.1.0 (engine satisfied path)', async () => {
    mockFs({
      [PLUGINS_DIR]: {
        'p': {
          'plugin.json': JSON.stringify({
            id: 'pub/p',
            name: 'P',
            version: '0.1.0',
            engines: { hive: '^0.1.0' },
          }),
        },
      },
    });
    const result = await discoverPlugins(PLUGINS_DIR, '0.1.0');
    expect(result[0].valid).toBe(true);
  });
});

describe('loadPlugin', () => {
  it('returns null when plugin.json is missing entirely', async () => {
    mockFs({ '/p': { 'README.md': 'x' } });
    const result = await loadPlugin('/p', '0.1.0');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readPluginAsset path safety
// ---------------------------------------------------------------------------

describe('readPluginAsset', () => {
  it('reads a file inside the plugin folder', async () => {
    mockFs({
      '/plugin-root': {
        'grammar.json': '{"defaultToken":""}',
      },
    });
    const text = await readPluginAsset('/plugin-root', 'grammar.json');
    expect(text).toBe('{"defaultToken":""}');
  });

  it('rejects ../ traversal', async () => {
    mockFs({
      '/plugin-root': { 'ok.json': '{}' },
      '/elsewhere': { 'secret.txt': 'leak' },
    });
    await expect(
      readPluginAsset('/plugin-root', '../elsewhere/secret.txt'),
    ).rejects.toThrow(/escapes plugin root/);
  });

  it('rejects an absolute path', async () => {
    mockFs({ '/plugin-root': { 'ok.json': '{}' } });
    await expect(
      readPluginAsset('/plugin-root', '/etc/passwd'),
    ).rejects.toThrow(/escapes plugin root/);
  });

  it('rejects a null byte in relPath', async () => {
    mockFs({ '/plugin-root': { 'ok.json': '{}' } });
    await expect(
      readPluginAsset('/plugin-root', 'ok.json\0/etc/passwd'),
    ).rejects.toThrow(/null byte/);
  });

  it('rejects an empty relPath', async () => {
    mockFs({ '/plugin-root': { 'ok.json': '{}' } });
    await expect(readPluginAsset('/plugin-root', '')).rejects.toThrow();
  });
});
