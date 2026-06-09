/**
 * Renderer-side fuzzy matching for quick-open (E2-03).
 *
 * A subsequence scorer (mirrors the main-process one) plus a convenience
 * `fuzzyFilter` that ranks a list of items by how well a key string matches
 * the query, dropping non-matches.
 */

/**
 * Subsequence fuzzy score. Returns -1 when `query` is not a subsequence of
 * `text`; higher is better. Rewards consecutive matches, matches after a path
 * separator / dot, and shorter targets.
 */
export function fuzzyScore(query: string, text: string): number {
  if (query === '') return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let prev = -2
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
    if (found === prev + 1) score += 5
    if (found === 0 || t[found - 1] === '/' || t[found - 1] === '\\' || t[found - 1] === '.')
      score += 3
    prev = found
    ti = found + 1
  }
  score += Math.max(0, 20 - Math.floor(text.length / 8))
  return score
}

/**
 * Rank `items` by fuzzy match of `query` against `key(item)`, dropping
 * non-matches. Stable for equal scores (preserves input order). An empty
 * query returns the items unchanged.
 */
export function fuzzyFilter<T>(
  query: string,
  items: ReadonlyArray<T>,
  key: (item: T) => string,
): T[] {
  if (query.trim() === '') return [...items]
  const scored: Array<{ item: T; score: number; i: number }> = []
  items.forEach((item, i) => {
    const score = fuzzyScore(query, key(item))
    if (score >= 0) scored.push({ item, score, i })
  })
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.map((s) => s.item)
}
