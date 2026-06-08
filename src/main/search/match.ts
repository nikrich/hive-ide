/**
 * Pure search primitives (E2-01) — no fs, fully unit-testable.
 *
 *   - {@link buildMatcher}  turns a query + options into a per-line scanner
 *     that returns the match ranges on a line (honouring case / whole-word /
 *     regex).
 *   - {@link globToRegExp} / {@link matchesAnyGlob} implement the small glob
 *     subset used for the search exclude list (`**`, `*`, `?`).
 *   - {@link looksBinary} sniffs a buffer prefix for NUL bytes.
 *   - {@link fuzzyScore} ranks file paths for quick-open (E2-03).
 */

export interface SearchOptions {
  /** Case-sensitive matching. */
  caseSensitive?: boolean
  /** Whole-word matching (word boundaries around the query). */
  wholeWord?: boolean
  /** Treat the query as a regular expression. */
  regex?: boolean
}

/** A half-open `[start, end)` column range (0-based) of a match on a line. */
export interface MatchRange {
  start: number
  end: number
}

export type LineMatcher = (line: string) => MatchRange[]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a per-line matcher. Throws on an invalid regex so the caller can
 * surface the error inline (E1-03 / E2 regex error).
 */
export function buildMatcher(query: string, opts: SearchOptions = {}): LineMatcher {
  if (query === '') return () => []
  let source = opts.regex ? query : escapeRegExp(query)
  if (opts.wholeWord) source = `\\b(?:${source})\\b`
  const flags = opts.caseSensitive ? 'g' : 'gi'
  const re = new RegExp(source, flags)

  return (line: string): MatchRange[] => {
    const ranges: MatchRange[] = []
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      // Zero-width matches (e.g. an empty-alternative regex) would loop
      // forever — advance lastIndex manually.
      if (m[0] === '') {
        re.lastIndex++
        continue
      }
      ranges.push({ start: m.index, end: m.index + m[0].length })
    }
    return ranges
  }
}

/**
 * Build the global RegExp used for replace-in-files. In literal mode the query
 * is escaped (and the replacement is applied verbatim by the caller); in regex
 * mode backreferences in the replacement string work as usual.
 */
export function buildReplaceRegExp(query: string, opts: SearchOptions = {}): RegExp {
  let source = opts.regex ? query : escapeRegExp(query)
  if (opts.wholeWord) source = `\\b(?:${source})\\b`
  const flags = opts.caseSensitive ? 'g' : 'gi'
  return new RegExp(source, flags)
}

/** Convert a glob (supporting `**`, `*`, `?`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` → any number of path segments (incl. separators)
        re += '.*'
        i++
        // swallow a trailing slash after `**` so `**/x` matches `x` too
        if (glob[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += escapeRegExp(c)
    }
  }
  return new RegExp(`(^|/)${re}(/|$)`)
}

/** True when `path` matches any of the supplied globs. */
export function matchesAnyGlob(path: string, globs: ReadonlyArray<string>): boolean {
  const normalized = path.replace(/\\/g, '/')
  for (const g of globs) {
    if (globToRegExp(g).test(normalized)) return true
  }
  return false
}

/** Heuristic: a NUL byte in the first chunk means "treat as binary". */
export function looksBinary(buf: Buffer | Uint8Array): boolean {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/**
 * Subsequence fuzzy score for quick-open (E2-03). Returns -1 when `query` is
 * not a subsequence of `text`; higher is better. Rewards consecutive matches,
 * matches right after a separator, and matches near the basename.
 */
export function fuzzyScore(query: string, text: string): number {
  if (query === '') return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let prevMatch = -2
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    let found = -1
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) {
        found = j
        break
      }
    }
    if (found === -1) return -1
    score += 1
    if (found === prevMatch + 1) score += 5 // consecutive
    if (found === 0 || t[found - 1] === '/' || t[found - 1] === '.') score += 3
    prevMatch = found
    ti = found + 1
  }
  // Prefer shorter paths (the query is a larger fraction of them).
  score += Math.max(0, 20 - Math.floor(text.length / 8))
  return score
}
