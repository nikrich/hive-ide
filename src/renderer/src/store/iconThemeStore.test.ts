import { describe, it, expect } from 'vitest';
import {
  buildIconThemeRegistry,
  BUILTIN_ICON_THEMES,
  iconThemePromptFor,
} from './iconThemeStore';
import type { LoadedPlugin, PluginManifest } from '../../../types/workspace';

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
      label: 'Material',
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

describe('iconThemePromptFor', () => {
  const withIconTheme = {
    id: 'hive/material-icons',
    name: 'Material',
    version: '1.0.0',
    contributes: {
      iconThemes: [
        { id: 'material', label: 'Material', path: './material-icons.json' },
      ],
    },
  } as unknown as PluginManifest;

  it('offers the theme when the user is on a built-in default', () => {
    expect(iconThemePromptFor(withIconTheme, 'lucide')).toEqual({
      id: 'material',
      label: 'Material',
    });
  });

  it('does not prompt when a non-built-in theme is already active', () => {
    expect(iconThemePromptFor(withIconTheme, 'some-other-theme')).toBeNull();
  });

  it('does not prompt for a plugin without icon themes', () => {
    const plain = {
      id: 'x/y',
      name: 'y',
      version: '1.0.0',
    } as unknown as PluginManifest;
    expect(iconThemePromptFor(plain, 'lucide')).toBeNull();
  });
});
