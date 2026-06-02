import { describe, expect, it } from 'vitest'

import type { Repo } from '../../../types/workspace'

import {
  basename,
  findOwningRepo,
  midEllipsize,
  relativeToRepo,
  reposWithOpenTabs,
  sepOf,
  tabLabel,
} from './tabLabel'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mkRepo = (name: string, path: string): Repo => ({
  name,
  path,
  isGitRepo: true,
})

const REPO_WEB = mkRepo('bff-web', '/projects/acme/bff-web')
const REPO_CLAIMS = mkRepo('bff-claims', '/projects/acme/bff-claims')
const REPO_OUTER = mkRepo('outer', '/projects/nested/outer')
const REPO_INNER = mkRepo('inner', '/projects/nested/outer/inner')

const REPO_WIN = mkRepo('bff-web', 'C:\\dev\\bff-web')

// ---------------------------------------------------------------------------
// sepOf / basename
// ---------------------------------------------------------------------------

describe('sepOf', () => {
  it('returns / for POSIX absolute paths', () => {
    expect(sepOf('/usr/local/bin/node')).toBe('/')
  })

  it('returns \\ for Windows absolute paths', () => {
    expect(sepOf('C:\\Users\\jannik\\code')).toBe('\\')
  })

  it('treats forward-slash strings as POSIX even on mixed input', () => {
    expect(sepOf('relative/path/with/no/back/slash')).toBe('/')
  })
})

describe('basename', () => {
  it('extracts last segment from POSIX paths', () => {
    expect(basename('/projects/acme/bff-web/src/index.ts')).toBe('index.ts')
  })

  it('extracts last segment from Windows paths', () => {
    expect(basename('C:\\dev\\bff-web\\src\\index.ts')).toBe('index.ts')
  })

  it('returns the input untouched when no separator is present', () => {
    expect(basename('Makefile')).toBe('Makefile')
  })
})

// ---------------------------------------------------------------------------
// midEllipsize
// ---------------------------------------------------------------------------

describe('midEllipsize', () => {
  it('leaves short strings untouched', () => {
    expect(midEllipsize('short.ts', 36)).toBe('short.ts')
  })

  it('mid-ellipsises strings longer than max', () => {
    const out = midEllipsize('aaaaaaaaaabbbbbbbbbbcccccccccc', 11)
    expect(out.length).toBe(11)
    expect(out).toContain('…')
    expect(out.startsWith('a')).toBe(true)
    expect(out.endsWith('c')).toBe(true)
  })

  it('preserves the trailing characters (the disambiguating filename)', () => {
    const long = 'a'.repeat(50) + 'b'.repeat(50) + 'tail.tsx'
    const out = midEllipsize(long, 20)
    // With max=20, the tail half is floor(19/2)=9 chars — long enough to
    // capture "tail.tsx" plus one preceding character.
    expect(out.endsWith('tail.tsx')).toBe(true)
    expect(out.includes('…')).toBe(true)
  })

  it('returns the input untouched when max is too small for an ellipsis', () => {
    expect(midEllipsize('something', 1)).toBe('something')
  })

  it('produces a result that never exceeds max characters', () => {
    const out = midEllipsize('the-quick-brown-fox-jumps-over-the-lazy-dog', 12)
    expect(out.length).toBeLessThanOrEqual(12)
  })
})

// ---------------------------------------------------------------------------
// findOwningRepo / relativeToRepo
// ---------------------------------------------------------------------------

describe('findOwningRepo', () => {
  it('matches the repo whose path is a prefix of the tab', () => {
    const got = findOwningRepo('/projects/acme/bff-web/src/index.ts', [REPO_WEB, REPO_CLAIMS])
    expect(got).toBe(REPO_WEB)
  })

  it('returns null when no repo matches', () => {
    const got = findOwningRepo('/elsewhere/file.ts', [REPO_WEB, REPO_CLAIMS])
    expect(got).toBeNull()
  })

  it('returns the longest matching prefix for nested repos', () => {
    const got = findOwningRepo('/projects/nested/outer/inner/lib/x.ts', [REPO_OUTER, REPO_INNER])
    expect(got).toBe(REPO_INNER)
  })

  it('handles Windows paths and separators', () => {
    const got = findOwningRepo('C:\\dev\\bff-web\\src\\index.ts', [REPO_WIN])
    expect(got).toBe(REPO_WIN)
  })

  it("doesn't match a sibling that happens to share a string prefix", () => {
    // `/projects/acme/bff-web2` must not be reported as owned by `bff-web`.
    const sibling = '/projects/acme/bff-web2/src/index.ts'
    const got = findOwningRepo(sibling, [REPO_WEB])
    expect(got).toBeNull()
  })
})

describe('relativeToRepo', () => {
  it('strips the repo prefix from a POSIX path', () => {
    expect(relativeToRepo('/projects/acme/bff-web/src/index.ts', REPO_WEB)).toBe('src/index.ts')
  })

  it('strips the repo prefix from a Windows path', () => {
    expect(relativeToRepo('C:\\dev\\bff-web\\src\\index.ts', REPO_WIN)).toBe('src\\index.ts')
  })

  it('returns the basename when tab path equals the repo root', () => {
    expect(relativeToRepo('/projects/acme/bff-web', REPO_WEB)).toBe('bff-web')
  })

  it('returns the absolute path unchanged when the tab is outside the repo', () => {
    expect(relativeToRepo('/elsewhere/x.ts', REPO_WEB)).toBe('/elsewhere/x.ts')
  })
})

// ---------------------------------------------------------------------------
// reposWithOpenTabs
// ---------------------------------------------------------------------------

describe('reposWithOpenTabs', () => {
  it('collects the set of repos that own at least one open tab', () => {
    const set = reposWithOpenTabs(
      [
        '/projects/acme/bff-web/src/a.ts',
        '/projects/acme/bff-web/src/b.ts',
        '/projects/acme/bff-claims/src/c.ts',
      ],
      [REPO_WEB, REPO_CLAIMS],
    )
    expect(set.size).toBe(2)
    expect(set.has(REPO_WEB.path)).toBe(true)
    expect(set.has(REPO_CLAIMS.path)).toBe(true)
  })

  it('skips tabs whose paths fall outside every known repo', () => {
    const set = reposWithOpenTabs(['/somewhere-else/x.ts'], [REPO_WEB])
    expect(set.size).toBe(0)
  })

  it('returns an empty set for no open tabs', () => {
    expect(reposWithOpenTabs([], [REPO_WEB]).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// tabLabel — the integration point
// ---------------------------------------------------------------------------

describe('tabLabel', () => {
  it('shows the bare filename when every open tab lives in the same repo', () => {
    const tabs = ['/projects/acme/bff-web/src/a.ts', '/projects/acme/bff-web/src/b.ts']
    const set = reposWithOpenTabs(tabs, [REPO_WEB, REPO_CLAIMS])
    expect(tabLabel(tabs[0], [REPO_WEB, REPO_CLAIMS], set)).toBe('a.ts')
    expect(tabLabel(tabs[1], [REPO_WEB, REPO_CLAIMS], set)).toBe('b.ts')
  })

  it('prefixes with `repoName / relativePath` when tabs span more than one repo', () => {
    const tabs = ['/projects/acme/bff-web/src/a.ts', '/projects/acme/bff-claims/src/c.ts']
    const set = reposWithOpenTabs(tabs, [REPO_WEB, REPO_CLAIMS])
    expect(tabLabel(tabs[0], [REPO_WEB, REPO_CLAIMS], set)).toBe('bff-web / src/a.ts')
    expect(tabLabel(tabs[1], [REPO_WEB, REPO_CLAIMS], set)).toBe('bff-claims / src/c.ts')
  })

  it('falls back to the bare filename for a tab outside every known repo', () => {
    const tabs = ['/projects/acme/bff-web/src/a.ts', '/elsewhere/x.ts']
    const set = reposWithOpenTabs(tabs, [REPO_WEB])
    // The first tab is in the only known repo, so reposWithTabs is size 1 — no prefix.
    expect(tabLabel(tabs[0], [REPO_WEB], set)).toBe('a.ts')
    // The orphan tab also collapses to its basename.
    expect(tabLabel(tabs[1], [REPO_WEB], set)).toBe('x.ts')
  })

  it('mid-ellipsises labels that exceed max length', () => {
    const longTab =
      '/projects/acme/bff-web/src/very/deeply/nested/path/to/a/file/with-a-long-name.tsx'
    const tabs = [longTab, '/projects/acme/bff-claims/src/c.ts']
    const set = reposWithOpenTabs(tabs, [REPO_WEB, REPO_CLAIMS])
    const label = tabLabel(longTab, [REPO_WEB, REPO_CLAIMS], set, 24)
    expect(label.length).toBeLessThanOrEqual(24)
    expect(label).toContain('…')
  })
})
