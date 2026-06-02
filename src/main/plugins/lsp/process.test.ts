/**
 * LSP process tests — REQ-007.
 *
 * Pure-helper coverage (the spawn path is covered indirectly through
 * the manager test with an injected `spawnServer`). We pin the path
 * expansion + safety guards in isolation because they're the entire
 * trust boundary for plugin-supplied commands.
 */

import { describe, expect, it } from 'vitest';

import { expandArgs, expandCommandPath, expandCwd } from './process';

const PLUGIN_DIR = '/var/hive/plugins/pub-hello';

describe('expandCommandPath', () => {
  it('returns the template unchanged when no token is present', () => {
    expect(expandCommandPath('java', PLUGIN_DIR)).toBe('java');
  });

  it('substitutes ${pluginDir} with the plugin folder', () => {
    expect(expandCommandPath('${pluginDir}/launch.sh', PLUGIN_DIR)).toBe(
      `${PLUGIN_DIR}/launch.sh`,
    );
  });

  it('rejects a path that escapes the plugin root via ..', () => {
    expect(() =>
      expandCommandPath('${pluginDir}/../other/launch.sh', PLUGIN_DIR),
    ).toThrow(/escapes plugin root/);
  });

  it('rejects an absolute path that lands outside the plugin root', () => {
    expect(() =>
      expandCommandPath('${pluginDir}/foo/../../../bin/sh', PLUGIN_DIR),
    ).toThrow(/escapes plugin root/);
  });

  it('accepts a nested path inside the plugin folder', () => {
    expect(
      expandCommandPath('${pluginDir}/bin/jdtls/launch.sh', PLUGIN_DIR),
    ).toBe(`${PLUGIN_DIR}/bin/jdtls/launch.sh`);
  });

  it('accepts a plugin folder that itself contains spaces', () => {
    // macOS userData lives under "/Library/Application Support/<app>/plugins/…".
    // The earlier implementation split on whitespace to extract the program
    // path, truncated to "/Users/<u>/Library/Application", and falsely
    // flagged the result as escaping the plugin root.
    const spaceDir = '/Users/jannik/Library/Application Support/hive-ide/plugins/pub-java';
    expect(expandCommandPath('${pluginDir}/launch.sh', spaceDir)).toBe(
      `${spaceDir}/launch.sh`,
    );
  });
});

describe('expandArgs', () => {
  it('passes through args without the token', () => {
    expect(expandArgs(['-data', '/tmp/jdtls'], PLUGIN_DIR)).toEqual([
      '-data',
      '/tmp/jdtls',
    ]);
  });

  it('expands the token inside args', () => {
    expect(expandArgs(['-jar', '${pluginDir}/launcher.jar'], PLUGIN_DIR)).toEqual(
      ['-jar', `${PLUGIN_DIR}/launcher.jar`],
    );
  });
});

describe('expandCwd', () => {
  it('passes through a literal cwd without the token', () => {
    expect(expandCwd('/some/repo', PLUGIN_DIR)).toBe('/some/repo');
  });

  it('expands the token inside the cwd', () => {
    expect(expandCwd('${pluginDir}/workdir', PLUGIN_DIR)).toBe(
      `${PLUGIN_DIR}/workdir`,
    );
  });

  it('rejects a cwd that escapes the plugin root via ..', () => {
    expect(() => expandCwd('${pluginDir}/../escape', PLUGIN_DIR)).toThrow(
      /escapes plugin root/,
    );
  });

  it('rejects a cwd containing a null byte', () => {
    expect(() => expandCwd('/repo\0/inject', PLUGIN_DIR)).toThrow(/null byte/);
  });
});
