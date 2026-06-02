/**
 * Hive IDE — Monaco language detection.
 *
 * Pure helper that maps a file path to a Monaco editor language id, extracted
 * from MonacoEditor (STORY-023) so it can be exercised without pulling in any
 * React / Monaco / DOM code. Matches the extension table called out in the
 * REQ-002 design doc.
 *
 * Matching is case-insensitive — `.TS` and `.Md` resolve the same way `.ts`
 * and `.md` do. Anything we don't recognise — including paths with no
 * extension at all, or extensions like `.xyz` — falls through to `plaintext`.
 */

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  css: 'css',
  md: 'markdown'
}

/**
 * Return the Monaco language id for `path`, or `'plaintext'` if the extension
 * isn't one of the languages REQ-002 ships with built-in smarts for.
 *
 * Pure: no I/O, no module state mutated between calls.
 */
export function languageForPath(path: string): string {
  const dot = path.lastIndexOf('.')
  // No dot at all, or trailing dot (e.g. "README.") — treat as no extension.
  if (dot < 0 || dot === path.length - 1) return 'plaintext'
  const ext = path.slice(dot + 1).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] ?? 'plaintext'
}
