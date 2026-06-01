/**
 * fileIcon(name) — given a filename, return the lucide icon name and the CSS
 * tint class to render an explorer-style file icon. Keyed by extension; the
 * mapping mirrors `design-reference/primitives.jsx`.
 *
 * Returns a tuple `[iconName, tintClass]` so callers can spread directly:
 *
 *     const [icon, tint] = fileIcon(node.name)
 *     <Icon name={icon} className={tint} />
 */
export type FileIconResult = readonly [iconName: string, tintClass: string]

const EXT_MAP: Record<string, FileIconResult> = {
  tsx: ['braces', 'ic-tsx'],
  ts: ['file-code', 'ic-ts'],
  js: ['file-code', 'ic-ts'],
  jsx: ['braces', 'ic-tsx'],
  json: ['braces', 'ic-json'],
  css: ['hash', 'ic-css'],
  md: ['file-text', 'ic-md'],
  svg: ['image', 'ic-xml'],
  xml: ['code', 'ic-xml'],
  html: ['code', 'ic-xml'],
}

const FALLBACK: FileIconResult = ['file', 'ic-md']

export function fileIcon(name: string): FileIconResult {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return EXT_MAP[ext] ?? FALLBACK
}
