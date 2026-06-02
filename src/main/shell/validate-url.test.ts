/**
 * validate-url.ts — REQ-002 / STORY-020.
 *
 * The allowlist is small and the schemes it rejects are exactly the
 * ones an attacker would try. Cover the obvious accept / reject cases
 * plus the malformed-input fallback.
 */

import { describe, expect, it } from 'vitest';

import { assertHttpUrl, isHttpUrl } from './validate-url';

describe('assertHttpUrl()', () => {
  it.each([
    'http://example.com',
    'https://example.com',
    'https://example.com/path?q=1#frag',
    'http://localhost:5173',
  ])('accepts %s', (url) => {
    expect(assertHttpUrl(url)).toMatch(/^https?:/);
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'vscode://file/etc/passwd',
    'slack://open',
    'mailto:foo@example.com',
    'tel:+15555550100',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com',
  ])('rejects %s', (url) => {
    expect(() => assertHttpUrl(url)).toThrow();
  });

  it('rejects malformed strings', () => {
    expect(() => assertHttpUrl('not a url')).toThrow(TypeError);
  });

  it('normalises the URL it returns', () => {
    // The URL parser appends the implicit trailing slash for an origin-only URL.
    expect(assertHttpUrl('https://example.com')).toBe('https://example.com/');
  });
});

describe('isHttpUrl()', () => {
  it('returns true for http(s)', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
  });

  it('returns false for everything else (no throw)', () => {
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});
