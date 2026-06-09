/**
 * Git tree decorations (E7-01) — pure, testable.
 *
 * Turns the per-repo SCM snapshots into a lookup the explorer uses to badge
 * files (M/A/U/D/R/C) and roll a change indicator up to ancestor folders.
 *
 * Entry paths are repo-relative with forward slashes; we join them onto the
 * repo's absolute path (preserving the repo's native separator) so the keys
 * match the absolute `entry.path` values the explorer renders.
 */

import type { GitStatusEntry, Repo } from '../../../types/workspace'

export type GitDecoState = GitStatusEntry['state']

export interface GitDecorations {
  /** Absolute file path → its change state. */
  files: Map<string, GitDecoState>
  /** Absolute folder paths that contain at least one changed descendant. */
  dirs: Set<string>
}

/** Single-letter badge + CSS modifier class for a state. */
export const DECO_META: Record<GitDecoState, { letter: string; cls: string }> = {
  modified: { letter: 'M', cls: 'mod' },
  added: { letter: 'A', cls: 'add' },
  untracked: { letter: 'U', cls: 'unt' },
  deleted: { letter: 'D', cls: 'del' },
  renamed: { letter: 'R', cls: 'ren' },
  conflicted: { letter: 'C', cls: 'cfl' },
}

function sepOf(p: string): '\\' | '/' {
  return p.includes('\\') ? '\\' : '/'
}

/** Severity rank so a folder rolls up its "worst" descendant change first. */
const RANK: Record<GitDecoState, number> = {
  conflicted: 0,
  deleted: 1,
  modified: 2,
  renamed: 3,
  added: 4,
  untracked: 5,
}

export type ScmSlots = Record<
  string,
  { entries: GitStatusEntry[] } | undefined
>

/**
 * Build the decoration lookup from the SCM snapshots keyed by repo path.
 * When a file has both staged and unstaged records the more-severe state wins.
 */
export function buildGitDecorations(
  scm: ScmSlots,
  repos: ReadonlyArray<Repo>,
): GitDecorations {
  const files = new Map<string, GitDecoState>()
  const dirs = new Set<string>()

  for (const repo of repos) {
    const slot = scm[repo.path]
    if (!slot) continue
    const sep = sepOf(repo.path)
    const root = repo.path.endsWith(sep) ? repo.path.slice(0, -1) : repo.path

    for (const entry of slot.entries) {
      const abs = root + sep + entry.path.split('/').join(sep)
      const existing = files.get(abs)
      if (existing === undefined || RANK[entry.state] < RANK[existing]) {
        files.set(abs, entry.state)
      }
      // Roll up to every ancestor folder, stopping at the repo root.
      let dir = abs
      for (;;) {
        const idx = dir.lastIndexOf(sep)
        if (idx <= root.length - 1) break
        dir = dir.slice(0, idx)
        if (dir.length < root.length) break
        dirs.add(dir)
      }
      dirs.add(root)
    }
  }

  return { files, dirs }
}
