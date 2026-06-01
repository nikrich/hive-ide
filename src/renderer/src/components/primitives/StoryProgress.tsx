export interface StoryProgressCounts {
  done: number
  review: number
  running: number
  pending: number
}

export interface StoryProgressProps {
  counts: StoryProgressCounts
}

type StoryProgressKey = keyof StoryProgressCounts

/**
 * Visual order of segments (left → right) and their fill colours.
 * Matches `design-reference/primitives.jsx`.
 */
const ORDER: readonly StoryProgressKey[] = ['done', 'review', 'running', 'pending']

const SEGMENT_COLOR: Record<StoryProgressKey, string> = {
  done: 'var(--status-done)',
  review: 'var(--status-review)',
  running: 'var(--status-running)',
  pending: 'rgba(148,163,184,.25)',
}

export function StoryProgress({ counts }: StoryProgressProps) {
  const total = ORDER.reduce((acc, key) => acc + counts[key], 0) || 1

  return (
    <div
      className="progress"
      style={{
        height: 6,
        borderRadius: 99,
        background: 'rgba(148,163,184,.14)',
        overflow: 'hidden',
        marginTop: 14,
        display: 'flex',
      }}
    >
      {ORDER.map((key) =>
        counts[key] ? (
          <i
            key={key}
            style={{
              display: 'block',
              height: '100%',
              width: `${(counts[key] / total) * 100}%`,
              background: SEGMENT_COLOR[key],
            }}
          />
        ) : null,
      )}
    </div>
  )
}
