# File Icon Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the file explorer recognizable, colourful per-language icons by adding a VSCode-format `iconThemes` plugin contribution point, shipping a first-party Material icon pack that is seeded into the user's plugin dir on first run.

**Architecture:** Core gains a contribution point + a pure matcher + a small zustand store that lazily loads SVGs through the existing `plugins:read-asset` IPC (returned as `data:` URLs), with the current lucide mapping kept as the always-present fallback. Material ships as a standalone generated plugin package bundled via electron-builder `extraResources` and copied into `userData/plugins` at boot.

**Tech Stack:** TypeScript, React 18, Electron, zustand, Vitest. Icon source: `material-icon-theme` (MIT) consumed at build time only.

---

## File Structure

**Core — types & main process**
- `src/types/workspace.ts` (modify) — add `PluginIconThemeContribution` + `contributes.iconThemes`.
- `src/main/plugins/loader.ts` (modify) — add lenient `parseIconThemes`, wire into `contributes`.
- `src/main/plugins/seed.ts` (create) — `seedBundledPlugins`, `markPluginUninstalled`.
- `src/main/plugins/handlers.ts` (modify) — write uninstall tombstone.
- `src/main/index.ts` (modify) — call `seedBundledPlugins` at boot.

**Core — renderer**
- `src/renderer/src/lib/iconThemeDoc.ts` (create) — pure: normalize doc + match precedence. No IPC.
- `src/renderer/src/store/iconThemeStore.ts` (create) — active theme id, loaded doc, SVG `data:`-URL cache, registry; async load via IPC.
- `src/renderer/src/components/primitives/FileIcon.tsx` (create) — `<FileIcon>` + `useResolvedIcon`.
- `src/renderer/src/components/primitives/fileIcon.ts` (modify) — export the lucide map as the `lucide` built-in; add a folder lucide helper.
- `src/renderer/src/components/primitives/index.ts` (modify) — export `FileIcon`.
- `src/renderer/src/components/Explorer.tsx` (modify) — three call sites use `<FileIcon>`.
- `src/renderer/src/App.tsx` (modify) — drive the icon-theme store from settings + plugins.

**Core — settings/picker**
- `src/types/settings.ts` (modify) — relax `IconThemeSetting` to `string`.
- `src/renderer/src/components/SettingsView.tsx` (modify) — dynamic option list for `workbench.iconTheme`.

**Material plugin**
- `scripts/gen-material-icons.mjs` (create) — generator.
- `resources/plugins/hive-material-icons/` (generated) — `plugin.json`, `material-icons.json`, `icons/*.svg`, `LICENSE`.
- `electron-builder.config.cjs` (modify) — `extraResources` entry.
- `package.json` (modify) — `material-icon-theme` devDependency + `gen:icons` script.

---

## SLICE 1 — Core: contribution point, resolver, render, picker

### Task 1: Add the `iconThemes` contribution type

**Files:**
- Modify: `src/types/workspace.ts` (contributes block ~368-381; add interface near `PluginThemeContribution`)

- [ ] **Step 1: Add the interface**

After the `PluginThemeContribution` interface (the block ending around line where `colors?` is declared), add:

```ts
/**
 * A file-icon theme a plugin contributes. `path` points (plugin-relative) at a
 * VSCode-format icon-theme JSON document; the renderer loads it and its SVGs
 * via `plugins:read-asset`. Selected globally through `workbench.iconTheme`.
 */
export interface PluginIconThemeContribution {
  id: string;
  label: string;
  /** Plugin-relative path to the icon-theme JSON (e.g. `./material-icons.json`). */
  path: string;
}
```

- [ ] **Step 2: Reference it in the contributes block**

In `PluginManifest['contributes']` (the inline object), after the `themes?: PluginThemeContribution[];` line add:

```ts
    /** File-icon themes the plugin contributes. Selected via workbench.iconTheme. */
    iconThemes?: PluginIconThemeContribution[];
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add src/types/workspace.ts
git commit -m "feat(plugins): add iconThemes contribution type"
```

---

### Task 2: Parse `iconThemes` in the loader (lenient)

**Files:**
- Modify: `src/main/plugins/loader.ts` (contributes assembly ~222-230; new parser near `parseThemes` ~359-378)
- Modify import at top of `loader.ts` (the type import list around line 36)
- Test: `src/main/plugins/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/main/plugins/loader.test.ts`:

```ts
describe('parseIconThemes (via validateManifest)', () => {
  const base = { id: 'pub/p', name: 'P', version: '1.0.0' };

  it('keeps a well-formed icon-theme entry', () => {
    const res = validateManifest({
      ...base,
      contributes: {
        iconThemes: [{ id: 'material', label: 'Material', path: './m.json' }],
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.contributes?.iconThemes).toEqual([
      { id: 'material', label: 'Material', path: './m.json' },
    ]);
  });

  it('drops malformed entries without invalidating the plugin', () => {
    const res = validateManifest({
      ...base,
      contributes: {
        iconThemes: [
          { id: 'ok', label: 'OK', path: './a.json' },
          { id: 'no-path', label: 'X' },
          { label: 'no-id', path: './b.json' },
          'garbage',
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.contributes?.iconThemes).toEqual([
      { id: 'ok', label: 'OK', path: './a.json' },
    ]);
  });
});
```

(If `validateManifest` is not already imported in the test file, confirm the existing tests' import line and reuse it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/loader.test.ts -t "parseIconThemes"`
Expected: FAIL (`iconThemes` is `undefined`).

- [ ] **Step 3: Add the parser and wire it**

In `src/main/plugins/loader.ts`, add `PluginIconThemeContribution` to the type import list (near line 36 where `PluginThemeContribution` is imported).

Add this function next to `parseThemes` (after it, ~line 378):

```ts
/** Lenient parser for contributes.iconThemes. Malformed entries are dropped. */
function parseIconThemes(
  raw: unknown,
): PluginIconThemeContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginIconThemeContribution[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.id !== 'string' ||
      typeof e.label !== 'string' ||
      typeof e.path !== 'string'
    ) {
      continue;
    }
    out.push({ id: e.id, label: e.label, path: e.path });
  }
  return out.length > 0 ? out : undefined;
}
```

In the `contributes = { ... }` assembly (~222-230), add:

```ts
      iconThemes: parseIconThemes(c.iconThemes),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/loader.test.ts -t "parseIconThemes"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/loader.ts src/main/plugins/loader.test.ts
git commit -m "feat(plugins): lenient-parse iconThemes contribution"
```

---

### Task 3: Pure icon-theme matcher

**Files:**
- Create: `src/renderer/src/lib/iconThemeDoc.ts`
- Test: `src/renderer/src/lib/iconThemeDoc.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/iconThemeDoc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeIconTheme, matchIconDef, iconPathFor } from './iconThemeDoc';

const RAW = {
  iconDefinitions: {
    _file: { iconPath: './icons/file.svg' },
    _folder: { iconPath: './icons/folder.svg' },
    _folder_open: { iconPath: './icons/folder-open.svg' },
    _java: { iconPath: './icons/java.svg' },
    _ts: { iconPath: './icons/ts.svg' },
    _testts: { iconPath: './icons/test-ts.svg' },
    _docker: { iconPath: './icons/docker.svg' },
    _src: { iconPath: './icons/folder-src.svg' },
    _src_open: { iconPath: './icons/folder-src-open.svg' },
  },
  file: '_file',
  folder: '_folder',
  folderExpanded: '_folder_open',
  fileExtensions: { java: '_java', ts: '_ts', 'test.ts': '_testts' },
  fileNames: { dockerfile: '_docker' },
  folderNames: { src: '_src' },
  folderNamesExpanded: { src: '_src_open' },
};

describe('normalizeIconTheme', () => {
  it('lowercases lookup keys and keeps defs', () => {
    const t = normalizeIconTheme(RAW);
    expect(t.fileExtensions.java).toBe('_java');
    expect(iconPathFor(t, '_java')).toBe('./icons/java.svg');
  });

  it('tolerates a missing/garbage document', () => {
    const t = normalizeIconTheme(null);
    expect(matchIconDef(t, 'x.ts', 'file', false)).toBeUndefined();
  });
});

describe('matchIconDef precedence', () => {
  const t = normalizeIconTheme(RAW);
  it('exact filename beats extension', () => {
    expect(matchIconDef(t, 'Dockerfile', 'file', false)).toBe('_docker');
  });
  it('longest compound extension wins', () => {
    expect(matchIconDef(t, 'Foo.test.ts', 'file', false)).toBe('_testts');
  });
  it('single extension', () => {
    expect(matchIconDef(t, 'Main.java', 'file', false)).toBe('_java');
  });
  it('falls back to the file default', () => {
    expect(matchIconDef(t, 'README', 'file', false)).toBe('_file');
  });
  it('folder open/closed', () => {
    expect(matchIconDef(t, 'src', 'folder', false)).toBe('_src');
    expect(matchIconDef(t, 'src', 'folder', true)).toBe('_src_open');
  });
  it('unknown folder uses folder default', () => {
    expect(matchIconDef(t, 'whatever', 'folder', false)).toBe('_folder');
    expect(matchIconDef(t, 'whatever', 'folder', true)).toBe('_folder_open');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/lib/iconThemeDoc.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the matcher**

Create `src/renderer/src/lib/iconThemeDoc.ts`:

```ts
/**
 * Pure VSCode-format icon-theme document handling. No IPC, no React — just
 * normalization and the filename → icon-definition-id match precedence. The
 * store layer (iconThemeStore) wires this to plugin assets; this module is
 * unit-tested in isolation.
 */

interface RawIconDef {
  iconPath?: string;
}

/** A normalized theme: lookups lowercased, defs flattened to iconPath. */
export interface NormalizedIconTheme {
  /** definitionId → plugin-relative iconPath (undefined for font-only defs). */
  defs: Record<string, string | undefined>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
}

function lowerKeys(obj: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof obj === 'object' && obj !== null) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string') out[k.toLowerCase()] = v;
    }
  }
  return out;
}

export function normalizeIconTheme(raw: unknown): NormalizedIconTheme {
  const empty: NormalizedIconTheme = {
    defs: {},
    fileExtensions: {},
    fileNames: {},
    folderNames: {},
    folderNamesExpanded: {},
  };
  if (typeof raw !== 'object' || raw === null) return empty;
  const r = raw as Record<string, unknown>;

  const defs: Record<string, string | undefined> = {};
  if (typeof r.iconDefinitions === 'object' && r.iconDefinitions !== null) {
    for (const [id, def] of Object.entries(
      r.iconDefinitions as Record<string, RawIconDef>,
    )) {
      defs[id] = typeof def?.iconPath === 'string' ? def.iconPath : undefined;
    }
  }

  return {
    defs,
    file: typeof r.file === 'string' ? r.file : undefined,
    folder: typeof r.folder === 'string' ? r.folder : undefined,
    folderExpanded:
      typeof r.folderExpanded === 'string' ? r.folderExpanded : undefined,
    fileExtensions: lowerKeys(r.fileExtensions),
    fileNames: lowerKeys(r.fileNames),
    folderNames: lowerKeys(r.folderNames),
    folderNamesExpanded: lowerKeys(r.folderNamesExpanded),
  };
}

/** Resolve a definition id for a filename. Returns undefined if no match. */
export function matchIconDef(
  theme: NormalizedIconTheme,
  name: string,
  kind: 'file' | 'folder',
  open: boolean,
): string | undefined {
  const lower = name.toLowerCase();

  if (kind === 'folder') {
    const named = open
      ? theme.folderNamesExpanded[lower] ?? theme.folderNames[lower]
      : theme.folderNames[lower];
    if (named) return named;
    return open ? theme.folderExpanded ?? theme.folder : theme.folder;
  }

  // Exact filename.
  if (theme.fileNames[lower]) return theme.fileNames[lower];

  // Compound then single extension: try the longest dotted suffix first.
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('.');
    if (theme.fileExtensions[candidate]) return theme.fileExtensions[candidate];
  }

  return theme.file;
}

/** Plugin-relative iconPath for a definition id, if it has one. */
export function iconPathFor(
  theme: NormalizedIconTheme,
  defId: string | undefined,
): string | undefined {
  if (defId === undefined) return undefined;
  return theme.defs[defId];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/lib/iconThemeDoc.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/iconThemeDoc.ts src/renderer/src/lib/iconThemeDoc.test.ts
git commit -m "feat(icons): pure VSCode-format icon-theme matcher"
```

---

### Task 4: Icon-theme registry helper + store

**Files:**
- Create: `src/renderer/src/store/iconThemeStore.ts`
- Test: `src/renderer/src/store/iconThemeStore.test.ts`

The pure `buildIconThemeRegistry(plugins)` is unit-tested; the async SVG loading is left to manual/e2e (it touches `window.hive`).

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/store/iconThemeStore.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/store/iconThemeStore.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the store**

Create `src/renderer/src/store/iconThemeStore.ts`:

```ts
/**
 * Active file-icon theme state. Built-in themes (`lucide`/`minimal`/`none`)
 * use the lucide mapping in fileIcon.ts and need no async loading. A
 * plugin-contributed theme id triggers a one-time load of its JSON + SVGs via
 * `plugins:read-asset`; SVGs are cached as `data:` URLs (no Blob/objectURL, so
 * this works in any environment). `version` bumps whenever a load completes so
 * subscribed icons re-render and upgrade from their lucide fallback.
 */
import { create } from 'zustand';

import type { LoadedPlugin } from '../../../types/workspace';
import {
  normalizeIconTheme,
  type NormalizedIconTheme,
} from '../lib/iconThemeDoc';

export const BUILTIN_ICON_THEMES = ['lucide', 'minimal', 'none'] as const;

export interface IconThemeRegistryEntry {
  pluginId: string;
  themePath: string;
}

/** themeId → owning plugin + plugin-relative JSON path. */
export type IconThemeRegistry = Record<string, IconThemeRegistryEntry>;

/** Pure: collect contributed icon themes from valid plugins. */
export function buildIconThemeRegistry(
  plugins: readonly LoadedPlugin[],
): IconThemeRegistry {
  const reg: IconThemeRegistry = {};
  for (const p of plugins) {
    if (!p.valid) continue;
    for (const t of p.manifest.contributes?.iconThemes ?? []) {
      reg[t.id] = { pluginId: p.manifest.id, themePath: t.path };
    }
  }
  return reg;
}

/** Join a plugin-relative theme-JSON dir with an iconPath from that JSON. */
export function resolveAssetRelPath(themePath: string, iconPath: string): string {
  const dir = themePath.replace(/[^/]*$/, ''); // strip filename
  const joined = (dir + iconPath).replace(/^\.\//, '');
  // Collapse `a/./b` and `a/../b` minimally — plugin paths are shallow.
  const segs: string[] = [];
  for (const s of joined.split('/')) {
    if (s === '.' || s === '') continue;
    if (s === '..') segs.pop();
    else segs.push(s);
  }
  return segs.join('/');
}

function svgDataUrl(text: string): string {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(text);
}

interface IconThemeState {
  activeId: string;
  registry: IconThemeRegistry;
  doc: NormalizedIconTheme | null;
  /** definitionId → data: URL (resolved SVGs only). */
  svgs: Record<string, string>;
  /** definitionIds that failed to load — don't retry in a tight loop. */
  failed: Set<string>;
  version: number;
  setRegistry: (plugins: readonly LoadedPlugin[]) => void;
  setActive: (id: string) => void;
  /** Look up a resolved SVG; kicks off a load on first miss. Returns url|null. */
  svgForDef: (defId: string, iconPath: string | undefined) => string | null;
}

export const useIconThemeStore = create<IconThemeState>((set, get) => ({
  activeId: 'lucide',
  registry: {},
  doc: null,
  svgs: {},
  failed: new Set(),
  version: 0,

  setRegistry: (plugins) => {
    set({ registry: buildIconThemeRegistry(plugins) });
    // If the active theme just became available/unavailable, reload it.
    get().setActive(get().activeId);
  },

  setActive: (id) => {
    const isBuiltin = (BUILTIN_ICON_THEMES as readonly string[]).includes(id);
    if (isBuiltin || get().registry[id] === undefined) {
      set({ activeId: id, doc: null, svgs: {}, failed: new Set() });
      set((s) => ({ version: s.version + 1 }));
      return;
    }
    const entry = get().registry[id];
    set({ activeId: id, doc: null, svgs: {}, failed: new Set() });
    const bridge = window.hive?.plugins;
    if (!bridge) return;
    void bridge
      .readAsset(entry.pluginId, entry.themePath)
      .then((text) => {
        if (get().activeId !== id) return; // superseded
        set({ doc: normalizeIconTheme(JSON.parse(text)) });
        set((s) => ({ version: s.version + 1 }));
      })
      .catch(() => {
        /* leave doc null → lucide fallback everywhere */
      });
  },

  svgForDef: (defId, iconPath) => {
    const s = get();
    const cached = s.svgs[defId];
    if (cached) return cached;
    if (s.failed.has(defId) || !iconPath || s.doc === null) return null;
    const entry = s.registry[s.activeId];
    const bridge = window.hive?.plugins;
    if (!entry || !bridge) return null;
    // Mark in-flight by pre-adding to failed-guard via a sentinel check:
    // we use a temporary reservation to avoid duplicate fetches.
    if (s.svgs[defId] === undefined && !s.failed.has(defId)) {
      const relPath = resolveAssetRelPath(entry.themePath, iconPath);
      void bridge
        .readAsset(entry.pluginId, relPath)
        .then((text) => {
          set((st) => ({ svgs: { ...st.svgs, [defId]: svgDataUrl(text) } }));
          set((st) => ({ version: st.version + 1 }));
        })
        .catch(() => {
          set((st) => {
            const failed = new Set(st.failed);
            failed.add(defId);
            return { failed };
          });
        });
    }
    return null;
  },
}));
```

Note on duplicate-fetch guard: `svgForDef` may be called repeatedly while a fetch is in flight. To keep it simple and correct, add a module-level in-flight `Set<string>` guard (below) rather than relying on store state, since React may call during render.

Add at the top of the file (after imports) and use it in `svgForDef`:

```ts
const inFlight = new Set<string>();
```

Then in `svgForDef`, replace the `if (s.svgs[defId] === undefined && !s.failed.has(defId)) {` guard body's start with an in-flight check:

```ts
    const key = s.activeId + '::' + defId;
    if (!inFlight.has(key)) {
      inFlight.add(key);
      const relPath = resolveAssetRelPath(entry.themePath, iconPath);
      void bridge
        .readAsset(entry.pluginId, relPath)
        .then((text) => {
          inFlight.delete(key);
          set((st) => ({ svgs: { ...st.svgs, [defId]: svgDataUrl(text) }, version: st.version + 1 }));
        })
        .catch(() => {
          inFlight.delete(key);
          set((st) => {
            const failed = new Set(st.failed);
            failed.add(defId);
            return { failed };
          });
        });
    }
    return null;
```

(Use this in-flight version; drop the earlier `if (s.svgs[defId] === undefined …)` block.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/store/iconThemeStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/store/iconThemeStore.ts src/renderer/src/store/iconThemeStore.test.ts
git commit -m "feat(icons): icon-theme store with registry + lazy SVG loading"
```

---

### Task 5: `<FileIcon>` component + `useResolvedIcon`

**Files:**
- Modify: `src/renderer/src/components/primitives/fileIcon.ts` (expose folder lucide helper)
- Create: `src/renderer/src/components/primitives/FileIcon.tsx`
- Modify: `src/renderer/src/components/primitives/index.ts`

- [ ] **Step 1: Add a folder lucide helper to fileIcon.ts**

Append to `src/renderer/src/components/primitives/fileIcon.ts`:

```ts
/** Lucide folder glyph + tint for the built-in themes. */
export function folderLucide(open: boolean): FileIconResult {
  return [open ? 'folder-open' : 'folder', 'ic-folder']
}
```

- [ ] **Step 2: Create the component**

Create `src/renderer/src/components/primitives/FileIcon.tsx`:

```tsx
/**
 * Resolves a filename to either a lucide glyph (built-in themes, or the
 * fallback while a contributed SVG loads) or a contributed SVG (data: URL).
 * Subscribes to the icon-theme store's `version` so tiles upgrade from lucide
 * to SVG as assets resolve.
 */
import { Icon } from './Icon';
import { fileIcon, folderLucide } from './fileIcon';
import { useIconThemeStore, BUILTIN_ICON_THEMES } from '../../store/iconThemeStore';
import { matchIconDef, iconPathFor } from '../../lib/iconThemeDoc';

export interface FileIconProps {
  name: string;
  kind: 'file' | 'folder';
  open?: boolean;
  size?: number;
}

export function FileIcon({ name, kind, open = false, size = 15 }: FileIconProps) {
  const activeId = useIconThemeStore((s) => s.activeId);
  const doc = useIconThemeStore((s) => s.doc);
  // Subscribe to version so a resolved SVG triggers a re-render.
  useIconThemeStore((s) => s.version);
  const svgForDef = useIconThemeStore((s) => s.svgForDef);

  const isBuiltin = (BUILTIN_ICON_THEMES as readonly string[]).includes(activeId);

  if (!isBuiltin && doc !== null) {
    const defId = matchIconDef(doc, name, kind, open);
    const iconPath = iconPathFor(doc, defId);
    const url = defId ? svgForDef(defId, iconPath) : null;
    if (url) {
      return (
        <span className="fi fi-svg" style={{ display: 'inline-flex' }}>
          <img src={url} width={size} height={size} alt="" draggable={false} />
        </span>
      );
    }
    // fall through to lucide while the SVG loads / if unmatched
  }

  const [iconName, tint] =
    kind === 'folder' ? folderLucide(open) : fileIcon(name);
  return (
    <span className={'fi ' + tint}>
      <Icon name={iconName} size={size} />
    </span>
  );
}
```

- [ ] **Step 3: Export it**

In `src/renderer/src/components/primitives/index.ts`, add an export for `FileIcon` alongside the existing `Icon` / `fileIcon` exports (match the file's existing export style, e.g. `export { FileIcon } from './FileIcon'`).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/primitives/FileIcon.tsx src/renderer/src/components/primitives/fileIcon.ts src/renderer/src/components/primitives/index.ts
git commit -m "feat(icons): FileIcon component resolving lucide or contributed SVG"
```

---

### Task 6: Wire `<FileIcon>` into the Explorer

**Files:**
- Modify: `src/renderer/src/components/Explorer.tsx` (import ~46; `OpenEditors.renderTab` ~107-132; `FolderRow` icon ~473-484; `FileRow` ~592, 630-632; `InlineInput` usages keep lucide)

- [ ] **Step 1: Update the import**

Change line 46 from:

```ts
import { Icon, fileIcon } from './primitives'
```
to:
```ts
import { Icon, fileIcon, FileIcon } from './primitives'
```

(`fileIcon` is still used by `InlineInput` callers that pass an `iconName` string; keep it.)

- [ ] **Step 2: OpenEditors tab icon**

In `renderTab` (~107-129) replace:

```tsx
    const [icon, tint] = fileIcon(baseName(path))
```
…and the JSX…
```tsx
        <span className={'fi ' + tint}>
          <Icon name={icon} size={13} />
        </span>
```
with (remove the `fileIcon` call line; replace the span):
```tsx
        <FileIcon name={baseName(path)} kind="file" size={13} />
```

- [ ] **Step 3: FolderRow icon (non-root)**

In `FolderRow`'s render (~473-484), replace the folder icon span:

```tsx
          <span className="fi ic-folder">
            <Icon
              name={
                isRepoRoot
                  ? 'git-branch'
                  : expanded
                    ? 'folder-open'
                    : 'folder'
              }
              size={15}
            />
          </span>
```
with:
```tsx
          {isRepoRoot ? (
            <span className="fi ic-folder">
              <Icon name="git-branch" size={15} />
            </span>
          ) : (
            <FileIcon name={name} kind="folder" open={expanded} size={15} />
          )}
```

- [ ] **Step 4: FileRow icon**

In `FileRow` (~592), the `const [iconName, tint] = fileIcon(entry.name)` is still needed for the rename `InlineInput` branch (it passes `iconName`/`tint` strings). Keep that line. Replace only the non-rename render's icon span (~630-632):

```tsx
      <span className={'fi ' + tint}>
        <Icon name={iconName} size={15} />
      </span>
```
with:
```tsx
      <FileIcon name={entry.name} kind="file" size={15} />
```

- [ ] **Step 5: Typecheck + run the renderer test suite**

Run: `npm run typecheck`
Expected: PASS.
Run: `npx vitest run src/renderer/src/lib src/renderer/src/store`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Explorer.tsx
git commit -m "feat(icons): render FileIcon in explorer tree and open-editors"
```

---

### Task 7: Relax the setting + dynamic picker options

**Files:**
- Modify: `src/types/settings.ts` (`IconThemeSetting` ~61)
- Modify: `src/renderer/src/components/SettingsView.tsx` (select render ~330-342)
- Modify: `src/renderer/src/App.tsx` (drive the store ~252-257)

- [ ] **Step 1: Relax the type**

In `src/types/settings.ts`, change:

```ts
export type IconThemeSetting = 'lucide' | 'minimal' | 'none'
```
to:
```ts
/**
 * File icon theme. `lucide`/`minimal`/`none` are always-present built-ins;
 * any other value is a plugin-contributed icon-theme id. Open string like
 * {@link ColorThemeSetting}.
 */
export type IconThemeSetting = string
```

Leave the `SETTINGS_SCHEMA` entry for `workbench.iconTheme` as-is (its static `options` list is the built-in trio; the picker augments it at render time).

- [ ] **Step 2: Drive the store from App.tsx**

In `src/renderer/src/App.tsx`, near the existing `const iconTheme = useSettingsStore(...)` (line 256), add the store wiring. Add imports at the top (match existing import grouping):

```tsx
import { useIconThemeStore } from './store/iconThemeStore'
```

After the `iconTheme` selector, add:

```tsx
  const pluginsList = useWorkspaceStore((s) => s.plugins)
  const setIconRegistry = useIconThemeStore((s) => s.setRegistry)
  const setIconActive = useIconThemeStore((s) => s.setActive)
  useEffect(() => {
    setIconRegistry(pluginsList)
  }, [pluginsList, setIconRegistry])
  useEffect(() => {
    setIconActive(iconTheme)
  }, [iconTheme, setIconActive])
```

(If `useEffect` / `useWorkspaceStore` are not already imported in App.tsx, add them to the existing imports.)

- [ ] **Step 3: Dynamic options in the picker**

In `src/renderer/src/components/SettingsView.tsx`, the select branch (~330-342) renders `input.options`. Special-case `workbench.iconTheme`. At the top of the component that renders a row (where `key`, `input` are in scope, ~281), compute the option list. Add an import:

```tsx
import { useWorkspaceStore } from '../store/workspaceStore'
import { buildIconThemeRegistry } from '../store/iconThemeStore'
```

Inside that component, before the return:

```tsx
  const plugins = useWorkspaceStore((s) => s.plugins)
  const selectOptions =
    input.type === 'select' && key === 'workbench.iconTheme'
      ? [...input.options, ...Object.keys(buildIconThemeRegistry(plugins))]
      : input.type === 'select'
        ? input.options
        : []
```

Then in the `input.type === 'select'` JSX, change `input.options.map((opt) => (` to `selectOptions.map((opt) => (`.

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm test`
Expected: PASS (whole suite).

- [ ] **Step 5: Commit**

```bash
git add src/types/settings.ts src/renderer/src/App.tsx src/renderer/src/components/SettingsView.tsx
git commit -m "feat(icons): open iconTheme setting + dynamic picker, drive store from settings"
```

---

## SLICE 2 — Material icon-theme plugin package

### Task 8: Generator script + dependency

**Files:**
- Modify: `package.json` (devDependency + script)
- Create: `scripts/gen-material-icons.mjs`

- [ ] **Step 1: Add the dependency and script**

Run: `npm install --save-dev material-icon-theme`

Then add to `package.json` `scripts`:

```json
    "gen:icons": "node scripts/gen-material-icons.mjs",
```

- [ ] **Step 2: Inspect the package layout**

Run: `node -e "const r=require('module').createRequire(process.cwd()+'/x'); console.log(require('path').dirname(r.resolve('material-icon-theme/package.json')))"`
Then: `ls "$(node -e "...path printed above...")"` and confirm the theme JSON path (typically `dist/material-icons.json`) and the `icons/` directory. Note the actual JSON filename for the next step.

- [ ] **Step 3: Write the generator**

Create `scripts/gen-material-icons.mjs`:

```js
// Generates resources/plugins/hive-material-icons/ from the MIT
// material-icon-theme package: a hive plugin.json, a copy of the icon-theme
// JSON with iconPaths rewritten to ./icons/<file>.svg, and the referenced SVGs.
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve('material-icon-theme/package.json'));

// Theme JSON: dist/material-icons.json (confirm in Step 2; adjust if needed).
const themeJsonPath = join(pkgRoot, 'dist', 'material-icons.json');
const iconsSrcDir = join(pkgRoot, 'icons');

const OUT = join('resources', 'plugins', 'hive-material-icons');
const OUT_ICONS = join(OUT, 'icons');

const theme = JSON.parse(await readFile(themeJsonPath, 'utf8'));

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT_ICONS, { recursive: true });

const outDefs = {};
let copied = 0;
for (const [id, def] of Object.entries(theme.iconDefinitions ?? {})) {
  if (typeof def?.iconPath !== 'string') continue; // skip font-only defs
  const svgName = basename(def.iconPath);
  await copyFile(join(iconsSrcDir, svgName), join(OUT_ICONS, svgName));
  outDefs[id] = { iconPath: './icons/' + svgName };
  copied++;
}

const outTheme = {
  iconDefinitions: outDefs,
  file: theme.file,
  folder: theme.folder,
  folderExpanded: theme.folderExpanded,
  fileExtensions: theme.fileExtensions ?? {},
  fileNames: theme.fileNames ?? {},
  folderNames: theme.folderNames ?? {},
  folderNamesExpanded: theme.folderNamesExpanded ?? {},
  languageIds: theme.languageIds ?? {},
};
await writeFile(join(OUT, 'material-icons.json'), JSON.stringify(outTheme));

const manifest = {
  id: 'hive/material-icons',
  name: 'Material Icon Theme',
  version: '1.0.0',
  publisher: 'hive',
  description: 'Colourful Material file icons (port of PKief/material-icon-theme, MIT).',
  contributes: {
    iconThemes: [
      { id: 'material', label: 'Material', path: './material-icons.json' },
    ],
  },
};
await writeFile(join(OUT, 'plugin.json'), JSON.stringify(manifest, null, 2));

// Carry the upstream licence.
try {
  await copyFile(join(pkgRoot, 'LICENSE'), join(OUT, 'LICENSE'));
} catch {
  // some publishes use LICENSE.md
  await copyFile(join(pkgRoot, 'LICENSE.md'), join(OUT, 'LICENSE')).catch(() => {});
}

console.log(`Generated ${OUT} with ${copied} icons.`);
```

- [ ] **Step 4: Commit the script + dependency**

```bash
git add package.json package-lock.json scripts/gen-material-icons.mjs
git commit -m "build(icons): material-icon-theme generator script"
```

---

### Task 9: Generate + commit the plugin assets

**Files:**
- Generated: `resources/plugins/hive-material-icons/**`

- [ ] **Step 1: Run the generator**

Run: `npm run gen:icons`
Expected: prints `Generated resources/plugins/hive-material-icons with N icons.` (N in the high hundreds / ~1000).

- [ ] **Step 2: Sanity-check the manifest loads**

Run: `node -e "const m=require('./resources/plugins/hive-material-icons/plugin.json'); console.log(m.id, m.contributes.iconThemes[0].id)"`
Expected: `hive/material-icons material`.

Run: `node -e "const t=require('./resources/plugins/hive-material-icons/material-icons.json'); console.log('java ->', t.fileExtensions.java, '| def', t.iconDefinitions[t.fileExtensions.java].iconPath)"`
Expected: a definition id and an `./icons/*.svg` path.

- [ ] **Step 3: Commit the generated pack**

```bash
git add resources/plugins/hive-material-icons
git commit -m "feat(icons): generated Material icon-theme plugin assets"
```

---

## SLICE 3 — Seed the Material plugin on first run

### Task 10: `seedBundledPlugins` + uninstall tombstone

**Files:**
- Create: `src/main/plugins/seed.ts`
- Test: `src/main/plugins/seed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/plugins/seed.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/seed.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement seeding**

Create `src/main/plugins/seed.ts`:

```ts
/**
 * First-run seeding of bundled plugins. The app ships first-party plugins
 * (e.g. the Material icon theme) under `resources/plugins/`; on boot we copy
 * each into the user's plugins dir if it isn't there. A `.seeded.json` ledger
 * records the seeded version per id and remembers user uninstalls so we never
 * resurrect a plugin the user removed.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

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

/** Compare dotted semver-ish strings. Returns true if `a` > `b`. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/seed.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/seed.ts src/main/plugins/seed.test.ts
git commit -m "feat(plugins): seedBundledPlugins with version + uninstall ledger"
```

---

### Task 11: Wire seeding into boot + uninstall, and bundle via electron-builder

**Files:**
- Modify: `src/main/index.ts` (whenReady ~217; the plugins-dir import already present)
- Modify: `src/main/plugins/handlers.ts` (uninstall handler ~172-177)
- Modify: `electron-builder.config.cjs` (after `files:` ~23)

- [ ] **Step 1: Bundle the plugin via extraResources**

In `electron-builder.config.cjs`, after the `files: [...]` line (~23) add:

```js
  extraResources: [{ from: 'resources/plugins', to: 'plugins' }],
```

- [ ] **Step 2: Seed at boot**

In `src/main/index.ts`, add the import near the other plugin imports (~68-70):

```ts
import { seedBundledPlugins } from './plugins/seed';
import { pluginsDirSync } from './plugins/storage';
```

(`pluginsDir` is already imported; `pluginsDirSync` may need adding — confirm and add if missing.)

Change the `whenReady` callback to async and seed first. Replace the line:

```ts
app.whenReady().then(() => {
```
with:
```ts
app.whenReady().then(async () => {
  // Seed bundled first-party plugins (e.g. the Material icon theme) before any
  // plugins:list / discovery so a fresh install has icons on first paint.
  try {
    const bundledDir = app.isPackaged
      ? join(process.resourcesPath, 'plugins')
      : join(app.getAppPath(), 'resources', 'plugins');
    await seedBundledPlugins({
      bundledDir,
      pluginsDir: pluginsDirSync(app),
    });
  } catch (err) {
    console.error('seedBundledPlugins failed (non-fatal):', err);
  }
```

(Ensure `process` and `join` are in scope — `join` is already imported; `process` is global in the main process.)

- [ ] **Step 3: Write the uninstall tombstone**

In `src/main/plugins/handlers.ts`, the uninstall handler (~172-177) currently:

```ts
    async (_event, raw: unknown): Promise<void> => {
      const id = assertIdPayload(raw);
      const dir = pluginDirFor(app, id);
      await uninstall(dir);
    },
```
Replace with:
```ts
    async (_event, raw: unknown): Promise<void> => {
      const id = assertIdPayload(raw);
      const dir = pluginDirFor(app, id);
      await uninstall(dir);
      // Remember the removal so boot-seeding won't resurrect a bundled plugin.
      await markPluginUninstalled(pluginsDirSync(app), id);
    },
```

Add imports at the top of `handlers.ts`: `markPluginUninstalled` from `./seed`, and `pluginsDirSync` from `./storage` (check the existing storage import line ~near `pluginDirFor` and extend it).

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/main/plugins/handlers.ts electron-builder.config.cjs
git commit -m "feat(plugins): seed bundled plugins at boot, tombstone on uninstall, bundle Material"
```

---

### Task 12: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the app in dev**

Run: `npm run dev`
Open a multi-repo worktree project.

- [ ] **Step 2: Confirm Material icons render**

Expected: `.java` files show the Material Java cup, `.ts`/`.json`/`.md`/`.py` etc. show distinct coloured icons; named folders (`src`, `node_modules`) show folder variants; `Dockerfile`/`package.json` show their special icons.

- [ ] **Step 3: Exercise the picker**

In Settings → Workbench → File Icon Theme, switch to `lucide` (today's look), `none` (icons hidden), `minimal` (greyed), and back to `material`. Expected: tree updates live each time, no reload.

- [ ] **Step 4: Exercise uninstall/seed**

In the Plugins view, uninstall "Material Icon Theme". Expected: tree falls back to lucide and the `material` option disappears from the picker. Restart `npm run dev`. Expected: it is **not** re-seeded (tombstone honoured).

- [ ] **Step 5: Report**

Note any deviation. If all pass, the feature is complete.

---

## Self-Review

**Spec coverage:**
- Contribution point `contributes.iconThemes` → Tasks 1, 2. ✓
- VSCode-schema resolver + match precedence + lucide fallback → Task 3 (matcher), Task 5 (fallback). ✓
- Lazy SVG via `readAsset`, cached, version-bump re-render → Task 4. ✓
- Active-theme selection extends `workbench.iconTheme`; built-in trio preserved (incl. `data-icons` CSS untouched) → Task 7. ✓
- Picker lists built-ins + contributed → Task 7. ✓
- Render sites (Explorer FileRow/FolderRow, OpenEditors) → Task 6. ✓
- Material as a generated plugin package → Tasks 8, 9. ✓
- Seed on first run + version refresh + uninstall tombstone → Tasks 10, 11. ✓
- electron-builder bundling → Task 11. ✓
- Testing (resolver units, loader lenient parse, seed idempotency, manual) → Tasks 2, 3, 4, 10, 12. ✓

**Placeholder scan:** No TODO/TBD; every code step carries full code. Task 8 Step 2 is a real inspection action (confirm the package's JSON filename), not a placeholder.

**Type consistency:** `NormalizedIconTheme`, `matchIconDef`, `iconPathFor`, `buildIconThemeRegistry`, `IconThemeRegistry`, `resolveAssetRelPath`, `BUILTIN_ICON_THEMES`, `seedBundledPlugins`, `markPluginUninstalled`, `PluginIconThemeContribution`, `folderLucide`, `FileIcon`/`FileIconProps` are all defined where first introduced and referenced consistently across tasks.

**Risk note (carried from spec):** SVG-via-`readAsset` is the most novel piece; Task 12 Step 2 is the real check that throughput/latency is acceptable. A `hive-plugin://` protocol is the documented future optimisation if needed — out of scope here.
