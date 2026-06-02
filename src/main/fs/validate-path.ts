/**
 * Validate a path crossing the IPC trust boundary.
 *
 * Every filesystem-touching IPC handler in `src/main/fs/handlers.ts` calls
 * this on every absolute-path argument *before* it hands the value to
 * `fs.*` / `shell.*`. The renderer is treated as untrusted input — a buggy
 * or compromised renderer could otherwise reach anywhere on disk through
 * relative segments (`../`), denormalised paths (`/foo/./bar`), or
 * null-byte truncation (`/foo\0/etc/passwd`).
 *
 * Defined by REQ-002 design doc, STORY-017.
 *
 * What we reject:
 *
 * - Non-string input            → `TypeError`
 * - Empty string                → `Error`
 * - Null byte anywhere in the path → `Error`
 *   (Node's fs APIs treat `\0` as a string terminator on some platforms,
 *    so callers can sneak past suffix checks by appending `\0/...`.)
 * - Non-absolute paths          → `Error`
 *   (Anything relative would be resolved against `process.cwd()`, which
 *    is the IDE binary's working directory — never what the caller meant.)
 * - Paths that aren't already normalised → `Error`
 *   (`/foo/./bar`, `/foo//bar`, `/foo/../bar` are all rejected; the
 *    renderer is expected to send paths it actually intends to act on,
 *    not ones that simplify to something else.)
 * - Paths containing a literal `..` path segment → `Error`
 *   (Defence-in-depth: for any absolute input this is also caught by the
 *    normalisation check, since `..` would either get collapsed away or
 *    leave the path unequal to `normalize(p)`. We keep this explicit so
 *    the intent is obvious and so a future change to the normalisation
 *    check can't silently widen what's accepted.)
 *
 * What we deliberately *don't* do:
 *
 * - **No project-root sandboxing.** The IDE has the user's full FS
 *   permissions, just like any editor — Reveal-in-Finder, opening files
 *   outside the active project, etc. all need to work. (Spec § Path
 *   validation, REQ-002.)
 */

import { isAbsolute, normalize, sep } from 'node:path';

export function validatePath(p: string): string {
  if (typeof p !== 'string') {
    throw new TypeError(
      `validatePath: expected string, got ${typeof p}`,
    );
  }
  if (p.length === 0) {
    throw new Error('validatePath: empty path');
  }
  if (p.includes('\0')) {
    throw new Error('validatePath: path contains null byte');
  }
  if (!isAbsolute(p)) {
    throw new Error(`validatePath: path is not absolute: ${p}`);
  }
  if (normalize(p) !== p) {
    throw new Error(`validatePath: path is not normalised: ${p}`);
  }
  if (p.split(sep).includes('..')) {
    throw new Error(`validatePath: path contains '..' segment: ${p}`);
  }
  return p;
}
