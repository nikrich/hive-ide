# File Icon Themes — Design

**Date:** 2026-06-18
**Branch:** `worktree-feat+file-icon-themes` (from `main`)
**Status:** Approved for planning

## Problem

The worktree file explorer renders the same generic lucide `file` glyph for
almost every file type — `.java`, `.py`, `.go`, etc. all look identical and
bland. We want recognizable, colourful per-language icons (the VSCode
experience), and we want the icon set to be swappable rather than hardcoded.

Today's behaviour lives in
`src/renderer/src/components/primitives/fileIcon.ts`: a 10-entry
`EXT_MAP` of `extension → [lucideIconName, tintClass]`, with a generic
`['file', 'ic-md']` fallback. There is already a `workbench.iconTheme`
setting (`'lucide' | 'minimal' | 'none'`, default `'lucide'`) whose value is
stamped onto the shell as `data-icons=…`; CSS keys two behaviours off it
(`none` hides icons, `minimal` greys them).

## Goal

Deliver rich file icons **as a plugin**, using the existing plugin
contribution system, while keeping the core lean (no ~1000 SVGs baked into the
core bundle). A first-party **Material** icon-theme plugin is bundled with the
app and seeded into the user's plugin directory on first run, so a fresh
install gets nice icons out of the box yet the pack remains a normal,
uninstallable/swappable plugin. Additional icon packs (Seti, Catppuccin, any
VSCode-format pack) can be installed like any other plugin.

## Non-goals

- Font-based icon themes (VSCode's `fonts`/`iconDefinitions[].fontCharacter`).
  We implement only the SVG subset of the VSCode icon-theme schema and ignore
  font fields leniently.
- Light/dark variant switching within a single icon theme
  (`light`/`highContrast` override maps). A theme exposes one icon set; the
  picker is the switch.
- File-icon associations driven by language id from open editors. We match by
  filename and extension only (the `languageIds` map is parsed but optional and
  may be deferred).
- Theming the activity-bar / tab / breadcrumb icons. Scope is the explorer
  tree and the Open Editors list.

## Architecture

Four pieces, three of them in core and one a standalone plugin package.

### 1. Contribution point — `contributes.iconThemes`

`src/types/workspace.ts` gains:

```ts
export interface PluginIconThemeContribution {
  /** Theme id, unique across plugins; selected via workbench.iconTheme. */
  id: string;
  /** Human-readable label shown in the picker. */
  label: string;
  /** Plugin-relative path to the VSCode-format icon-theme JSON. */
  path: string;
}
```

and `PluginContributions` gains `iconThemes?: PluginIconThemeContribution[]`.

`src/main/plugins/loader.ts` parses it with the same lenient strategy used for
languages/themes/debuggers: each entry is validated independently; a malformed
entry is dropped (logged) and does **not** invalidate the plugin or its other
contributions. An entry is kept only when `id`, `label`, and `path` are all
non-empty strings.

### 2. Icon-theme document format (VSCode subset)

The file referenced by `path` is a VSCode `IconThemeDocument`. We consume this
subset:

```jsonc
{
  "iconDefinitions": {
    "_java": { "iconPath": "./icons/java.svg" }
    // ... fontCharacter/fontColor/fontId fields ignored if present
  },
  "file": "_file",                  // default file icon definition id
  "folder": "_folder",              // default collapsed folder
  "folderExpanded": "_folder_open", // default expanded folder
  "fileExtensions": { "java": "_java", "test.ts": "_test_ts" },
  "fileNames":      { "dockerfile": "_docker", "package.json": "_npm" },
  "folderNames":    { "src": "_folder_src", "node_modules": "_folder_node" },
  "folderNamesExpanded": { "src": "_folder_src_open" },
  "languageIds":    { "java": "_java" }   // optional, may be deferred
}
```

Match precedence (mirrors VSCode), all case-insensitive on the lookup key:

1. **Exact filename** — `fileNames[name.toLowerCase()]`.
2. **Compound extension** — the longest dotted suffix that matches a
   `fileExtensions` key. For `Foo.test.ts`, try `test.ts` before `ts`.
3. **Single extension** — `fileExtensions[lastSegment]`.
4. **Default** — the `file` definition.

Folders match `folderNames` / `folderNamesExpanded` by lowercased name, with
`folder` / `folderExpanded` as defaults. Repo roots keep the existing
`git-branch` lucide glyph (an Explorer concern, decided before the resolver is
consulted).

### 3. Resolver — `src/renderer/src/lib/iconTheme.ts` (new)

Replaces the `EXT_MAP` lookup. Public surface:

```ts
export type IconResolution =
  | { kind: 'lucide'; name: string; tint: string }
  | { kind: 'svg'; src: string };

export function resolveIcon(
  name: string,
  kind: 'file' | 'folder',
  open: boolean,
): IconResolution;
```

Behaviour by active theme (read from `workbench.iconTheme`):

- **`lucide`** (default) / **`minimal`** / **`none`** — return the existing
  lucide mapping. `minimal`/`none` are still expressed through the existing
  `data-icons` CSS on `.shell`; the resolver behaves identically to today for
  these so nothing regresses. (We keep the legacy `EXT_MAP` as the `lucide`
  built-in.)
- **any other id** — look up the loaded contributed icon-theme document and
  apply the precedence above.

SVG loading is async but the resolver is sync, so:

- On first request for a given `iconDefinitions` entry, the resolver kicks off
  `window.hive.plugins.readAsset(pluginId, relPath)` (returns the SVG as a utf8
  string — SVG is text, so the existing string-returning IPC is sufficient),
  converts it to an object URL (`URL.createObjectURL(new Blob([text],
  {type:'image/svg+xml'}))`), and caches it in a `Map<defId, string>`.
- Until the URL is ready, the resolver returns the **lucide** equivalent for
  that file (graceful fallback — the tree never blanks and never blocks on
  IPC). A lightweight version counter / store bump triggers a re-render when a
  batch of SVGs resolves, so tiles upgrade from lucide to SVG without manual
  refresh.
- An icon-theme document is itself fetched once (via `readAsset`) when a theme
  becomes active, parsed, normalized into the lookup structure, and cached for
  the session. Switching themes swaps the active document and bumps the version.

A `none`-style "blank" never happens for a contributed theme: a missing
definition falls through to the theme `file` default, then to lucide `file`.

### 4. Render sites — `<FileIcon>` wrapper

A small component `src/renderer/src/components/primitives/FileIcon.tsx`:

```tsx
export function FileIcon({ name, kind, open, size }: {
  name: string; kind: 'file' | 'folder'; open?: boolean; size?: number;
}) {
  const res = useResolvedIcon(name, kind, open ?? false); // subscribes to theme version
  if (res.kind === 'svg') return <img className="fi-svg" src={res.src} width={size} height={size} alt="" />;
  return <span className={'fi ' + res.tint}><Icon name={res.name} size={size} /></span>;
}
```

Call sites updated:

- `Explorer.tsx` `FileRow` — replace `fileIcon()` + `<Icon>` with `<FileIcon>`.
- `Explorer.tsx` `FolderRow` — folder icon goes through `<FileIcon kind="folder" open={expanded}>`, except repo roots (keep `git-branch`).
- `Explorer.tsx` `OpenEditors.renderTab` — same `<FileIcon>`.
- `InlineInput` new-file/new-folder/rename rows — use `<FileIcon>` for preview.

`fileIcon.ts` keeps exporting the lucide `EXT_MAP` (now the `lucide` built-in
theme data) so the resolver and any remaining callers share one source.

### 5. Seeding bundled plugins (main process)

`electron-builder.config.cjs` already bundles `resources/**/*`. The Material
plugin is placed at `resources/plugins/<id-folder>/` in the build.

New `src/main/plugins/seed.ts` exposes `seedBundledPlugins(app)`:

- For each directory under `<resourcesPath>/plugins/`, compute the target
  `<userData>/plugins/<id-folder>/`.
- If the target is absent **and** no "uninstalled" marker exists for that id,
  copy the bundled plugin in.
- If the target exists but the bundled `version` is newer than the installed
  one (and not user-uninstalled), refresh it. A small
  `<userData>/plugins/.seeded.json` records `{ id: seededVersion }` and
  uninstall writes a tombstone there so a user uninstall is not undone on the
  next launch.

Called in `src/main/index.ts` in `whenReady`, **before** the existing
`discoverPlugins` call (currently ~line 241) so seeded plugins are present for
the first discovery. Wrapped in try/catch — a seeding failure logs and is
non-fatal (the app still boots, just without default icons).

### 6. Active-theme picker

`src/types/settings.ts`: relax `IconThemeSetting` from the fixed union to
`string` (keeping `'lucide'`/`'minimal'`/`'none'` as the always-present
built-ins), and change the settings-schema entry's `input` from a static
`select` to a dynamic option source so it lists built-ins + every `iconThemes`
id from enabled, valid plugins. The renderer reads the plugin list from the
workspace store (already populated via `plugins:list`) and the active theme via
the existing settings store; `App.tsx` continues to stamp `data-icons` (only
meaningful for the built-in trio).

## Data flow

```
boot: seedBundledPlugins() → discoverPlugins() → renderer plugins:list
                                                        │
settings.workbench.iconTheme ──► resolver active theme ─┤
                                                        ▼
Explorer row ─ resolveIcon(name,kind,open) ─► lucide (sync)            ─► <Icon>
                                          └─► svg defId not cached?     ─► readAsset → blob URL → cache → version bump → re-render ─► <img>
```

## Error handling

- **Missing/invalid icon-theme JSON** — theme fails to load; resolver falls
  back to `lucide` for all files; a notification surfaces the parse error.
- **`readAsset` failure for one SVG** — that icon stays on its lucide fallback;
  logged once, not retried in a tight loop (negative-cache the defId).
- **Seeding failure** — logged, non-fatal; app boots with default `lucide`.
- **Unknown active theme id** (e.g. plugin uninstalled while selected) —
  resolver falls back to `lucide`; the picker shows the missing id as inactive.

## Testing

- **Resolver unit tests** (Vitest, pure): exact-name beats extension; longest
  compound extension wins; single-extension; folder open/closed; default
  fallbacks; unknown theme → lucide; `none`/`minimal`/`lucide` parity with
  today.
- **Loader tests**: `iconThemes` lenient parsing — valid entry kept; malformed
  entry dropped without invalidating sibling contributions or the plugin.
- **Seed tests**: copies when absent; idempotent on second run; respects the
  uninstall tombstone; refreshes on newer bundled version.
- **Manual / Playwright**: open a multi-repo worktree, confirm Java/Python/etc.
  show distinct Material icons, switch the picker to `lucide`/`none` and back,
  uninstall the Material plugin and confirm fallback.

## Slices

1. **Core: contribution point + resolver + render sites + picker.** Ships with
   the `lucide` built-in as default (no behaviour change to a fresh install
   yet) but everything pluggable. Resolver and loader fully unit-tested.
2. **Material plugin package.** Generated from the MIT `material-icon-theme`
   npm package by a prune script that emits `plugin.json` +
   `material-icons.json` + the referenced SVGs. Lives in its own package
   directory; build copies it to `resources/plugins/`.
3. **Seeding.** `seedBundledPlugins` + boot wiring + tombstone handling, so the
   Material plugin is present and active by default on a fresh install.

## Open questions / risks

- **SVG-via-`readAsset` throughput.** One async IPC string call per *distinct*
  icon (not per row), cached for the session. For a tree with dozens of file
  types this is tens of calls, batched as folders expand — acceptable, but the
  most novel part. If it proves slow, a future optimisation is a single
  `readAssetBatch` or a custom `hive-plugin://` protocol; out of scope now.
- **Material licence/attribution.** `material-icon-theme` is MIT; include its
  licence in the generated plugin package.
- **Plugin id / folder naming** for the Material pack to be finalised in the
  plan (e.g. `hive/material-icons`).
