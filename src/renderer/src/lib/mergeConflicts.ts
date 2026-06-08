/**
 * Git merge-conflict parsing + resolution (E7-06).
 *
 * Parses a working-tree file containing conflict markers into a sequence of
 * plain-text and conflict segments, and rebuilds the file once the user picks a
 * side per conflict. Pure + dependency-free so it's unit-testable.
 *
 * Markers (git's diff3 or default style):
 *   <<<<<<< ours
 *   …current…
 *   ||||||| base            (optional, diff3)
 *   …base…
 *   =======
 *   …incoming…
 *   >>>>>>> theirs
 */

export interface ConflictSegment {
  type: 'conflict'
  current: string[]
  base?: string[]
  incoming: string[]
  currentLabel: string
  incomingLabel: string
  /** Resolution chosen by the user, or undefined while unresolved. */
  resolution?: 'current' | 'incoming' | 'both' | 'base'
}

export interface TextSegment {
  type: 'text'
  lines: string[]
}

export type MergeSegment = TextSegment | ConflictSegment

const START = /^<<<<<<< ?(.*)$/
const BASE = /^\|\|\|\|\|\|\| ?(.*)$/
const SEP = /^=======\s*$/
const END = /^>>>>>>> ?(.*)$/

/** True when the text contains at least one conflict marker. */
export function hasConflicts(text: string): boolean {
  return START.test(text) || text.includes('<<<<<<<')
}

/** Parse conflict-marked text into segments. */
export function parseConflicts(text: string): MergeSegment[] {
  const lines = text.split('\n')
  const segments: MergeSegment[] = []
  let textBuf: string[] = []
  const flushText = (): void => {
    if (textBuf.length > 0) {
      segments.push({ type: 'text', lines: textBuf })
      textBuf = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const start = START.exec(lines[i])
    if (start === null) {
      textBuf.push(lines[i])
      i++
      continue
    }
    // Enter a conflict.
    flushText()
    const currentLabel = start[1].trim()
    const current: string[] = []
    const base: string[] = []
    const incoming: string[] = []
    let phase: 'current' | 'base' | 'incoming' = 'current'
    let incomingLabel = ''
    i++
    for (; i < lines.length; i++) {
      const line = lines[i]
      if (BASE.test(line)) {
        phase = 'base'
        continue
      }
      if (SEP.test(line)) {
        phase = 'incoming'
        continue
      }
      const end = END.exec(line)
      if (end !== null) {
        incomingLabel = end[1].trim()
        i++
        break
      }
      if (phase === 'current') current.push(line)
      else if (phase === 'base') base.push(line)
      else incoming.push(line)
    }
    segments.push({
      type: 'conflict',
      current,
      base: base.length > 0 ? base : undefined,
      incoming,
      currentLabel: currentLabel || 'Current',
      incomingLabel: incomingLabel || 'Incoming',
    })
  }
  flushText()
  return segments
}

/** The resolved lines for a conflict given its chosen resolution. */
function resolvedLines(c: ConflictSegment): string[] {
  switch (c.resolution) {
    case 'incoming':
      return c.incoming
    case 'both':
      return [...c.current, ...c.incoming]
    case 'base':
      return c.base ?? []
    case 'current':
      return c.current
    default:
      return c.current // default to current when not chosen
  }
}

/** True when every conflict in the segment list has been resolved. */
export function allResolved(segments: ReadonlyArray<MergeSegment>): boolean {
  return segments.every(
    (s) => s.type !== 'conflict' || s.resolution !== undefined,
  )
}

/** Rebuild the file text from segments using each conflict's resolution. */
export function serialize(segments: ReadonlyArray<MergeSegment>): string {
  const out: string[] = []
  for (const s of segments) {
    if (s.type === 'text') out.push(...s.lines)
    else out.push(...resolvedLines(s))
  }
  return out.join('\n')
}
