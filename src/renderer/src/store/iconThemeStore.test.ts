import { describe, it, expect } from 'vitest';
import { buildIconThemeRegistry, BUILTIN_ICON_THEMES } from './iconThemeStore';
import type { LoadedPlugin } from '../../../types/workspace';

function plugin(id: string, valid: boolean, iconThemes?: unknown): LoadedPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      contributes: iconThemes ? { iconThemes } : undefined,
    },
    rootPath: '/p/' + id,
    valid,
  } as unknown as LoadedPlugin;
}

describe('buildIconThemeRegistry', () => {
  it('maps theme id to plugin id + path for valid plugins', () => {
    const reg = buildIconThemeRegistry([
      plugin('hive/material-icons', true, [
        { id: 'material', label: 'Material', path: './material-icons.json' },
      ]),
    ]);
    expect(reg.material).toEqual({
      pluginId: 'hive/material-icons',
      themePath: './material-icons.json',
    });
  });

  it('ignores invalid plugins and plugins without iconThemes', () => {
    const reg = buildIconThemeRegistry([
      plugin('a/b', false, [{ id: 'x', label: 'X', path: './x.json' }]),
      plugin('c/d', true),
    ]);
    expect(reg.x).toBeUndefined();
    expect(Object.keys(reg)).toHaveLength(0);
  });

  it('exposes the three built-in ids', () => {
    expect(BUILTIN_ICON_THEMES).toEqual(['lucide', 'minimal', 'none']);
  });
});
