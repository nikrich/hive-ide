/**
 * End-to-end data-pipeline check for the bundled Material icon-theme plugin.
 *
 * Exercises the REAL generated plugin under `resources/plugins/hive-material-icons/`
 * through the renderer-side units the app uses: registry building, document
 * normalization, and the match resolver — then asserts the resolved icon paths
 * point at SVG files that actually exist on disk. This catches breakage between
 * the generator output and the resolver that per-unit tests can't (e.g. an
 * iconPath rewrite or schema drift).
 *
 * Stays renderer-only by design (the main-side loader is unit-tested
 * separately, and `tsc -b` forbids crossing the main/renderer project
 * boundary). It does NOT exercise Electron IPC or the GUI — only the data flow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildIconThemeRegistry } from '../store/iconThemeStore';
import { normalizeIconTheme, matchIconDef, iconPathFor } from './iconThemeDoc';
import type { LoadedPlugin } from '../../../types/workspace';

const PLUGIN_DIR = join(
  __dirname,
  '../../../../resources/plugins/hive-material-icons',
);

function loadGeneratedPlugin(): LoadedPlugin {
  const manifest = JSON.parse(
    readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8'),
  );
  // Structural sanity (the main-side loader validates this thoroughly in
  // loader.test.ts; here we just confirm the generator emitted the contract).
  expect(manifest.id).toBe('hive/material-icons');
  expect(manifest.contributes?.iconThemes?.[0]?.id).toBe('material');
  return { manifest, rootPath: PLUGIN_DIR, valid: true };
}

describe('Material icon theme — generated plugin pipeline', () => {
  const plugin = loadGeneratedPlugin();

  it('manifest contributes the `material` icon theme', () => {
    const reg = buildIconThemeRegistry([plugin]);
    expect(reg.material).toEqual({
      pluginId: 'hive/material-icons',
      themePath: './material-icons.json',
      label: 'Material',
    });
  });

  const theme = normalizeIconTheme(
    JSON.parse(readFileSync(join(PLUGIN_DIR, 'material-icons.json'), 'utf8')),
  );

  it('resolves common files/folders to on-disk SVGs', () => {
    const cases: Array<[string, 'file' | 'folder', boolean]> = [
      ['Main.java', 'file', false],
      ['index.ts', 'file', false],
      ['app.py', 'file', false],
      ['Dockerfile', 'file', false],
      ['package.json', 'file', false],
      ['src', 'folder', false],
      ['src', 'folder', true],
      ['node_modules', 'folder', false],
    ];
    for (const [name, kind, open] of cases) {
      const defId = matchIconDef(theme, name, kind, open);
      expect(defId, `${name} should resolve a def`).toBeDefined();
      const iconPath = iconPathFor(theme, defId);
      expect(iconPath, `${name} def should have an iconPath`).toBeDefined();
      const rel = (iconPath as string).replace(/^\.\//, '');
      expect(
        existsSync(join(PLUGIN_DIR, rel)),
        `${name} → ${iconPath} should exist`,
      ).toBe(true);
    }
  });

  it('falls back to the file default for an unknown extension', () => {
    const defId = matchIconDef(theme, 'mystery.zzz', 'file', false);
    expect(defId).toBe(theme.file);
    expect(iconPathFor(theme, defId)).toBeDefined();
  });
});
