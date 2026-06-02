/**
 * detect() — REQ-002 / STORY-016
 *
 * One test per branch of the 4-rule detection algorithm, driven by
 * `mock-fs` fixtures so the tests are hermetic and don't touch the
 * developer's real disk.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import mockFs from 'mock-fs';

import { detect } from './detect';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

describe('detect()', () => {
  afterEach(() => {
    mockFs.restore();
  });

  // --- Rule 1: .hive/config.yaml --------------------------------------------

  it('classifies a folder containing .hive/config.yaml as source=hive', async () => {
    mockFs({
      '/work/acme': {
        '.hive': {
          'config.yaml':
            'teams:\n' +
            '  - name: web\n' +
            '    repo_path: repos/web\n' +
            '  - name: api\n' +
            '    repo_path: repos/api\n',
        },
        repos: {
          web: { '.git': { HEAD: 'ref: refs/heads/main' } },
          api: {
            /* deliberately not a git repo to prove isGitRepo is read per-repo */
          },
        },
      },
    });

    const project = await detect('/work/acme');

    expect(project.source).toBe('hive');
    expect(project.id).toBe(sha1('/work/acme'));
    expect(project.name).toBe('acme');
    expect(project.rootPath).toBe('/work/acme');
    expect(project.lastOpenedAt).toBeGreaterThan(0);
    expect(project.repos).toEqual([
      { name: 'web', path: '/work/acme/repos/web', isGitRepo: true },
      { name: 'api', path: '/work/acme/repos/api', isGitRepo: false },
    ]);
  });

  // --- Rule 2: any direct child has .git/ -----------------------------------

  it('classifies a folder whose direct children are git repos as source=auto-detected', async () => {
    mockFs({
      '/work/mono': {
        'fe-app': { '.git': { HEAD: 'ref: refs/heads/main' }, 'package.json': '{}' },
        'be-app': { '.git': { HEAD: 'ref: refs/heads/main' }, 'go.mod': 'module x' },
        docs: { 'README.md': '# notes' }, // not a git repo → excluded
        '.DS_Store': '',
      },
    });

    const project = await detect('/work/mono');

    expect(project.source).toBe('auto-detected');
    expect(project.repos.map((r) => r.name)).toEqual(['be-app', 'fe-app']);
    expect(project.repos.every((r) => r.isGitRepo)).toBe(true);
    expect(project.repos.map((r) => r.path)).toEqual(['/work/mono/be-app', '/work/mono/fe-app']);
  });

  // --- Rule 3: root itself is a git repo ------------------------------------

  it('classifies a folder whose root has .git/ as source=single-repo', async () => {
    mockFs({
      '/work/solo': {
        '.git': { HEAD: 'ref: refs/heads/main' },
        'README.md': '# solo',
        src: { 'index.ts': 'export {};' },
      },
    });

    const project = await detect('/work/solo');

    expect(project.source).toBe('single-repo');
    expect(project.repos).toEqual([{ name: 'solo', path: '/work/solo', isGitRepo: true }]);
  });

  // --- Rule 4: empty --------------------------------------------------------

  it('classifies a folder with no .hive config, no child git repos, and no root .git as source=empty', async () => {
    mockFs({
      '/work/blank': {
        'notes.md': 'just a folder',
        subdir: { 'a.txt': 'a' }, // not a git repo, no .git anywhere
      },
    });

    const project = await detect('/work/blank');

    expect(project.source).toBe('empty');
    expect(project.repos).toEqual([]);
    expect(project.id).toBe(sha1('/work/blank'));
    expect(project.name).toBe('blank');
  });

  // --- Rule precedence sanity check -----------------------------------------

  it('prefers .hive/config.yaml over a root .git when both are present', async () => {
    mockFs({
      '/work/both': {
        '.git': { HEAD: 'ref: refs/heads/main' },
        '.hive': { 'config.yaml': 'teams:\n  - name: only\n    repo_path: ./\n' },
      },
    });

    const project = await detect('/work/both');

    expect(project.source).toBe('hive');
    // The single team points at root, which itself has .git/ → isGitRepo: true.
    expect(project.repos).toEqual([{ name: 'only', path: '/work/both', isGitRepo: true }]);
  });
});
