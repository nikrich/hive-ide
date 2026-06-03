/**
 * Parser tests — fixture-string driven, no subprocesses.
 *
 * Records in porcelain v2 with `-z` are NUL-delimited. The fixtures here
 * use `\0` explicitly so they're easy to read.
 */

import { describe, expect, it } from 'vitest';

import {
  parseAheadBehind,
  parseBranchOutput,
  parseStatusPorcelainV2,
} from './parsers';

describe('parseStatusPorcelainV2', () => {
  it('returns an empty array on empty input', () => {
    expect(parseStatusPorcelainV2('')).toEqual([]);
  });

  it('parses a single untracked file', () => {
    const fixture = '? new-file.ts\0';
    expect(parseStatusPorcelainV2(fixture)).toEqual([
      {
        path: 'new-file.ts',
        state: 'untracked',
        staged: false,
        workingTree: true,
      },
    ]);
  });

  it('parses an unstaged modification', () => {
    // X='.' (no staged change), Y='M' (modified in worktree)
    const fixture = '1 .M N... 100644 100644 100644 abc def src/index.ts\0';
    expect(parseStatusPorcelainV2(fixture)).toEqual([
      {
        path: 'src/index.ts',
        state: 'modified',
        staged: false,
        workingTree: true,
      },
    ]);
  });

  it('parses a staged modification', () => {
    const fixture = '1 M. N... 100644 100644 100644 abc def src/index.ts\0';
    expect(parseStatusPorcelainV2(fixture)).toEqual([
      {
        path: 'src/index.ts',
        state: 'modified',
        staged: true,
        workingTree: false,
      },
    ]);
  });

  it('emits two entries for partially-staged modifications', () => {
    // The same file is staged AND modified again in the working tree.
    const fixture = '1 MM N... 100644 100644 100644 abc def src/index.ts\0';
    const result = parseStatusPorcelainV2(fixture);
    expect(result).toEqual([
      {
        path: 'src/index.ts',
        state: 'modified',
        staged: true,
        workingTree: false,
      },
      {
        path: 'src/index.ts',
        state: 'modified',
        staged: false,
        workingTree: true,
      },
    ]);
  });

  it('parses a staged addition', () => {
    const fixture = '1 A. N... 000000 100644 100644 abc def new.ts\0';
    expect(parseStatusPorcelainV2(fixture)).toEqual([
      {
        path: 'new.ts',
        state: 'added',
        staged: true,
        workingTree: false,
      },
    ]);
  });

  it('parses a staged deletion', () => {
    const fixture = '1 D. N... 100644 000000 000000 abc def gone.ts\0';
    expect(parseStatusPorcelainV2(fixture)).toEqual([
      {
        path: 'gone.ts',
        state: 'deleted',
        staged: true,
        workingTree: false,
      },
    ]);
  });

  it('parses an unmerged conflict', () => {
    const fixture =
      'u UU N... 100644 100644 100644 100644 a b c src/conflicted.ts\0';
    expect(parseStatusPorcelainV2(fixture)).toEqual([
      {
        path: 'src/conflicted.ts',
        state: 'conflicted',
        staged: true,
        workingTree: true,
      },
    ]);
  });

  it('parses a staged rename', () => {
    const fixture = '2 R. N... 100644 100644 100644 abc def R100 new.ts\0old.ts\0';
    expect(parseStatusPorcelainV2(fixture)).toEqual([
      {
        path: 'new.ts',
        oldPath: 'old.ts',
        state: 'renamed',
        staged: true,
        workingTree: false,
      },
    ]);
  });

  it('skips ignored files and branch header rows', () => {
    const fixture =
      '# branch.oid 0000000\0# branch.head main\0! ignored.log\0? new.ts\0';
    expect(parseStatusPorcelainV2(fixture)).toEqual([
      {
        path: 'new.ts',
        state: 'untracked',
        staged: false,
        workingTree: true,
      },
    ]);
  });
});

describe('parseAheadBehind', () => {
  it('extracts ahead/behind from branch.ab header', () => {
    const fixture =
      '# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n';
    expect(parseAheadBehind(fixture)).toEqual({ ahead: 2, behind: 1 });
  });

  it('returns zeros when no upstream header is present', () => {
    const fixture = '# branch.oid abc\n# branch.head feature\n';
    expect(parseAheadBehind(fixture)).toEqual({ ahead: 0, behind: 0 });
  });

  it('handles large counts', () => {
    expect(parseAheadBehind('# branch.ab +123 -456\n')).toEqual({
      ahead: 123,
      behind: 456,
    });
  });
});

describe('parseBranchOutput', () => {
  it('classifies locals and remotes and tags the current branch', () => {
    const fixture = ['main\t*', 'feat/foo\t ', 'origin/main\t ', 'origin/HEAD\t '].join(
      '\n',
    );
    expect(parseBranchOutput(fixture)).toEqual({
      current: 'main',
      local: ['feat/foo', 'main'],
      remote: ['origin/main'],
    });
  });

  it('returns empty arrays + empty current on empty input', () => {
    expect(parseBranchOutput('')).toEqual({ current: '', local: [], remote: [] });
  });
});
