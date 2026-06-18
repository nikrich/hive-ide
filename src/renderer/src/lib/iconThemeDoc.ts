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
