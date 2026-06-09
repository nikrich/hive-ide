/**
 * Marketplace registry tests (E10-01, E10-02).
 */

import { describe, expect, it } from 'vitest';

import { isUpdateAvailable, parseRegistry } from './registry';

describe('parseRegistry', () => {
  it('parses valid entries and drops invalid ones', () => {
    const doc = {
      version: 1,
      plugins: [
        {
          id: 'hive.python',
          name: 'Python',
          description: 'Pyright',
          repo: { owner: 'nikrich', repo: 'plugins' },
          latest: '0.2.0',
        },
        { id: 'no-name', repo: { owner: 'a', repo: 'b' } },
        { id: 'no-repo', name: 'X' },
        42,
      ],
    };
    const out = parseRegistry(doc);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'hive.python',
      name: 'Python',
      latest: '0.2.0',
      repo: { owner: 'nikrich', repo: 'plugins' },
    });
  });

  it('returns [] for non-object / missing plugins', () => {
    expect(parseRegistry(null)).toEqual([]);
    expect(parseRegistry({})).toEqual([]);
    expect(parseRegistry({ plugins: 'nope' })).toEqual([]);
  });
});

describe('isUpdateAvailable', () => {
  it('detects a newer version', () => {
    expect(isUpdateAvailable('0.1.0', '0.2.0')).toBe(true);
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false);
    expect(isUpdateAvailable('2.0.0', '1.5.0')).toBe(false);
  });
  it('is tolerant of loose versions', () => {
    expect(isUpdateAvailable('v0.1', '0.2.0')).toBe(true);
    expect(isUpdateAvailable('garbage', '1.0.0')).toBe(false);
  });
});
