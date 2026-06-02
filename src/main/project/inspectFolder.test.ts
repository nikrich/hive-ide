/**
 * inspectFolder() — REQ-003.
 *
 * Two branches: folder has `.git/`, folder does not. Plus a basename sanity
 * case and a propagation case for unexpected errors so we can't regress to
 * silently swallowing things.
 */

import { afterEach, describe, expect, it } from 'vitest';
import mockFs from 'mock-fs';

import { inspectFolder } from './inspectFolder';

describe('inspectFolder()', () => {
  afterEach(() => {
    mockFs.restore();
  });

  it('returns isGitRepo=true when the folder contains .git/', async () => {
    mockFs({
      '/work/solo': {
        '.git': { HEAD: 'ref: refs/heads/main' },
        'README.md': '# solo',
      },
    });

    const result = await inspectFolder('/work/solo');

    expect(result).toEqual({
      path: '/work/solo',
      name: 'solo',
      isGitRepo: true,
    });
  });

  it('returns isGitRepo=false when no .git/ is present', async () => {
    mockFs({
      '/work/blank': {
        'notes.md': 'plain folder',
        subdir: { 'a.txt': 'a' },
      },
    });

    const result = await inspectFolder('/work/blank');

    expect(result).toEqual({
      path: '/work/blank',
      name: 'blank',
      isGitRepo: false,
    });
  });

  it('resolves the path so trailing slashes and `.` segments do not skew basename', async () => {
    mockFs({
      '/work/acme': {
        '.git': { HEAD: 'ref: refs/heads/main' },
      },
    });

    const result = await inspectFolder('/work/acme/./');
    expect(result.path).toBe('/work/acme');
    expect(result.name).toBe('acme');
    expect(result.isGitRepo).toBe(true);
  });
});
