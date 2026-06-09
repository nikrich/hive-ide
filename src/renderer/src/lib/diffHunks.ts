/**
 * Unified-diff hunk parsing (E7-04 inline gutter, E7-02 hunk staging).
 *
 * `computeLineChanges` turns a `git diff` (working tree vs HEAD) into per-line
 * change classifications on the NEW side, so the editor can paint gutter
 * markers: added (green), modified (blue), and deleted-after (red caret).
 *
 * `parseHunks` exposes the raw hunks (header + body lines) so a single hunk can
 * be turned back into a minimal patch for staging.
 *
 * Pure + dependency-free → unit-testable with fixture strings.
 */

export interface DiffHunk {
  /** Start line on the old (HEAD) side, 1-based. */
  oldStart: number
  oldLines: number
  /** Start line on the new (working-tree) side, 1-based. */
  newStart: number
  newLines: number
  /** The hunk's `@@ … @@` header line. */
  header: string
  /** Body lines including their leading ' ', '+', or '-'. */
  lines: string[]
}

export interface LineChanges {
  /** New-side line numbers that are purely added. */
  added: number[]
  /** New-side line numbers that replaced an old line (modified). */
  modified: number[]
  /** New-side line numbers after which one or more lines were deleted. */
  deleted: number[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Parse a unified diff into its hunks (ignores the file header lines). */
export function parseHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  const lines = diff.split('\n')
  let current: DiffHunk | null = null
  for (const line of lines) {
    const m = HUNK_HEADER.exec(line)
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: line,
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current === null) continue
    // Stop collecting at the next file header.
    if (line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      current = null
      continue
    }
    if (line === '' || line[0] === ' ' || line[0] === '+' || line[0] === '-' || line.startsWith('\\')) {
      current.lines.push(line)
    }
  }
  return hunks
}

/**
 * Classify each new-side line as added / modified / deleted-after by walking
 * change blocks: within a run of removals (d) + additions (a), the first
 * min(d,a) additions are "modified", extra additions are "added", and when
 * removals exceed additions a "deleted" caret sits after the block.
 */
export function computeLineChanges(diff: string): LineChanges {
  const added: number[] = []
  const modified: number[] = []
  const deleted: number[] = []

  for (const hunk of parseHunks(diff)) {
    let newLine = hunk.newStart
    let i = 0
    const body = hunk.lines
    while (i < body.length) {
      const line = body[i]
      if (line.startsWith('\\')) {
        i++
        continue
      }
      if (line.startsWith(' ')) {
        newLine++
        i++
        continue
      }
      // Start of a change block: gather consecutive '-' then '+'.
      let dels = 0
      let adds = 0
      const blockStart = newLine
      while (i < body.length && body[i].startsWith('-')) {
        dels++
        i++
      }
      const addLines: number[] = []
      while (i < body.length && body[i].startsWith('+')) {
        addLines.push(newLine)
        newLine++
        adds++
        i++
      }
      const modCount = Math.min(dels, adds)
      for (let k = 0; k < addLines.length; k++) {
        if (k < modCount) modified.push(addLines[k])
        else added.push(addLines[k])
      }
      if (dels > adds) {
        // Pure deletion (or more removed than added) → caret after the block.
        deleted.push(adds > 0 ? newLine - 1 : Math.max(1, blockStart - 1))
      }
    }
  }
  return { added, modified, deleted }
}

/**
 * Build a minimal one-hunk unified patch (with proper `---`/`+++` headers) that
 * `git apply --cached` accepts, for staging a single hunk (E7-02).
 */
export function buildHunkPatch(repoRelPath: string, hunk: DiffHunk): string {
  const a = `a/${repoRelPath}`
  const b = `b/${repoRelPath}`
  return (
    `diff --git ${a} ${b}\n` +
    `--- ${a}\n` +
    `+++ ${b}\n` +
    `${hunk.header}\n` +
    hunk.lines.join('\n') +
    '\n'
  )
}
