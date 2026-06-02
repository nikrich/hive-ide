/**
 * validatePath() — REQ-002 / STORY-017
 *
 * One test per rejection rule plus an accept-path baseline. Pure string
 * predicates, no filesystem fixtures needed.
 *
 * The acceptance criterion calls out four rules explicitly:
 *
 *   - absolute-only       (no relative paths)
 *   - no `..`             (no traversal segments)
 *   - no `\0`             (no null byte)
 *   - no non-normalised   (no `/foo/./bar`, no `/foo//bar`)
 *
 * We also pin the happy-path: a plain absolute path must round-trip.
 */

import { describe, expect, it } from 'vitest';

import { validatePath } from './validate-path';

describe('validatePath()', () => {
  // --- happy path -----------------------------------------------------------

  it('returns the path unchanged when it is absolute, normalised, and clean', () => {
    expect(validatePath('/work/acme/src/index.ts')).toBe(
      '/work/acme/src/index.ts',
    );
  });

  it('accepts a plain root path', () => {
    expect(validatePath('/')).toBe('/');
  });

  // --- absolute-only --------------------------------------------------------

  it('rejects a relative path', () => {
    expect(() => validatePath('foo/bar')).toThrow(/not absolute/);
  });

  it('rejects a leading-dot relative path', () => {
    expect(() => validatePath('./foo')).toThrow(/not absolute/);
  });

  it('rejects a parent-relative path', () => {
    // Caught by the absolute-only rule before the `..` rule fires —
    // either reason is acceptable, but the path must be rejected.
    expect(() => validatePath('../etc/passwd')).toThrow();
  });

  // --- no `..` traversal ----------------------------------------------------

  it('rejects an absolute path with a `..` segment in the middle', () => {
    // /work/acme/../etc — normalisation would collapse this to /work/etc,
    // so it fails the normalisation rule first; the message proves the
    // path was rejected, which is what callers care about.
    expect(() => validatePath('/work/acme/../etc')).toThrow();
  });

  it('rejects an absolute path ending in `..`', () => {
    expect(() => validatePath('/work/acme/..')).toThrow();
  });

  // --- no null byte ---------------------------------------------------------

  it('rejects a path containing a null byte', () => {
    expect(() => validatePath('/work/acme\0/etc/passwd')).toThrow(/null byte/);
  });

  it('rejects a null byte even at the end of the path', () => {
    expect(() => validatePath('/work/acme\0')).toThrow(/null byte/);
  });

  // --- normalisation --------------------------------------------------------

  it('rejects an unnormalised path with `//`', () => {
    expect(() => validatePath('/work//acme')).toThrow(/normalised/);
  });

  it('rejects an unnormalised path with `.` segments', () => {
    expect(() => validatePath('/work/./acme')).toThrow(/normalised/);
  });

  // --- input shape ----------------------------------------------------------

  it('rejects non-string input with a TypeError', () => {
    // The IPC layer is typed, but a misbehaving renderer can still
    // serialise garbage across the bridge. Treat the boundary as untrusted.
    expect(() => validatePath(undefined as unknown as string)).toThrow(
      TypeError,
    );
    expect(() => validatePath(123 as unknown as string)).toThrow(TypeError);
  });

  it('rejects an empty string', () => {
    expect(() => validatePath('')).toThrow(/empty/);
  });
});
