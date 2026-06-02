/**
 * Hive IDE — tab-label helpers (STORY-024).
 *
 * The Editor's tab strip has to disambiguate between files with the same
 * basename open across different repos: `bff-web/src/index.ts` and
 * `bff-claims/src/index.ts` should both be reachable without staring at
 * the tooltip. These helpers compute the visible label.
 *
 * Rules called out in the story:
 * - When every open tab lives in the same repo (or in no detected repo
 *   at all), tabs show the bare filename.
 * - When open tabs span more than one repo, every tab shows
 *   `repoName / relativePath`.
 * - Long labels are mid-ellipsised so the head and tail of the string
 *   remain visible. The full absolute path always goes into `title`.
 *
 * Path separator is sniffed off the path itself — Windows absolute paths
 * contain `\\`, POSIX paths don't — so these helpers stay testable without
 * stubbing the Electron preload bridge.
 */

import type { Repo } from '../../../types/workspace'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum visual length of a tab label before mid-ellipsis kicks in. Tuned
 * so most "normal" labels (`repo / src/lib/foo.ts`) fit, but a chain of
 * deeply-nested folders gets clipped instead of stretching the tab strip.
 */
export const MAX_TAB_LABEL_LEN = 36

// ---------------------------------------------------------------------------
// Path primitives
// ---------------------------------------------------------------------------

/** Return `'\\'` for Windows absolute paths, `'/'` otherwise. */
export function sepOf(p: string): '\\' | '/' {
  return p.includes('\\') ? '\\' : '/'
}

/** Last path segment, separator-agnostic. Returns `p` if no separator found. */
export function basename(p: string): string {
  const s = sepOf(p)
  const i = p.lastIndexOf(s)
  return i === -1 ? p : p.slice(i + 1)
}

// ---------------------------------------------------------------------------
// Ellipsis
// ---------------------------------------------------------------------------

/**
 * Mid-ellipsise `label` so it never exceeds `max` characters. Preserves the
 * head and tail of the string — important for tab labels, where the tail
 * is usually the filename that disambiguates the tab.
 *
 * If `max` is smaller than 2 the label is returned untouched: there's no
 * useful representation with only an ellipsis and one character.
 */
export function midEllipsize(label: string, max: number = MAX_TAB_LABEL_LEN): string {
  if (max < 2 || label.length <= max) return label
  const keep = max - 1 // reserve a slot for the ellipsis itself
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return label.slice(0, head) + '…' + label.slice(label.length - tail)
}

// ---------------------------------------------------------------------------
// Repo lookup
// ---------------------------------------------------------------------------

/**
 * Return the repo whose `path` is an ancestor of `tabPath`, or `null` when
 * the tab lives outside every known repo. The longest matching prefix wins
 * so a nested repo (`/proj/outer/inner` inside `/proj/outer`) resolves to
 * the inner one.
 */
export function findOwningRepo(tabPath: string, repos: readonly Repo[]): Repo | null {
  let best: Repo | null = null
  for (const r of repos) {
    const sep = sepOf(r.path)
    const prefix = r.path.endsWith(sep) ? r.path : r.path + sep
    if (tabPath === r.path || tabPath.startsWith(prefix)) {
      if (!best || r.path.length > best.path.length) best = r
    }
  }
  return best
}

/**
 * Relative path of `tabPath` inside `repo`, using the repo's separator.
 * Falls back to the basename when `tabPath === repo.path`, and to the
 * absolute path when `tabPath` is not actually under `repo`.
 */
export function relativeToRepo(tabPath: string, repo: Repo): string {
  const sep = sepOf(repo.path)
  const prefix = repo.path.endsWith(sep) ? repo.path : repo.path + sep
  if (tabPath.startsWith(prefix)) return tabPath.slice(prefix.length)
  if (tabPath === repo.path) return basename(repo.path)
  return tabPath
}

// ---------------------------------------------------------------------------
// The label itself
// ---------------------------------------------------------------------------

/**
 * Compute the visible label for one tab.
 *
 * @param tabPath          Absolute path of the tab's file.
 * @param repos            All repos the workspace knows about.
 * @param reposWithTabs    Set of repo paths that have at least one open tab —
 *                         the disambiguation key. When its size is `<= 1`
 *                         every tab collapses to its bare filename.
 * @param max              Max characters before mid-ellipsis. Mostly useful
 *                         for tests; production callers should accept the
 *                         default.
 */
export function tabLabel(
  tabPath: string,
  repos: readonly Repo[],
  reposWithTabs: ReadonlySet<string>,
  max: number = MAX_TAB_LABEL_LEN,
): string {
  const repo = findOwningRepo(tabPath, repos)
  if (!repo || reposWithTabs.size <= 1) return midEllipsize(basename(tabPath), max)
  const rel = relativeToRepo(tabPath, repo)
  return midEllipsize(`${repo.name} / ${rel}`, max)
}

/**
 * Build the `reposWithTabs` set for a given collection of open tab paths.
 * Exposed so the Editor can compute it once per render and reuse it across
 * every tab's `tabLabel` call.
 */
export function reposWithOpenTabs(
  tabPaths: readonly string[],
  repos: readonly Repo[],
): Set<string> {
  const out = new Set<string>()
  for (const p of tabPaths) {
    const r = findOwningRepo(p, repos)
    if (r) out.add(r.path)
  }
  return out
}
