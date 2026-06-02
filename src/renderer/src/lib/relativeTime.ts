/**
 * Hive IDE — relative-time formatter.
 *
 * Pure helper used by the Welcome / Projects hub to render a recent
 * project's `lastOpenedAt` timestamp as a short, human-readable phrase
 * ("just now", "5 minutes ago", "yesterday", "3 weeks ago"…).
 *
 * The formatter is deliberately minimal — Hive IDE never needs second-
 * level precision, and avoiding a dependency on `Intl.RelativeTimeFormat`
 * keeps the helper trivially unit-testable: no locale plumbing, no
 * Node-vs-browser quirks.
 *
 * Negative deltas (the timestamp is in the future) collapse to "just now"
 * rather than producing "-3 minutes ago".
 */

/** Internal threshold table. First match wins. */
interface Threshold {
  /** Inclusive upper bound for `deltaMs` to apply this rule, in ms. */
  upTo: number
  /** Number of ms per unit, used to compute `floor(delta / perUnit)`. */
  perUnit: number
  /** Singular label (`"minute"`). */
  singular: string
  /** Plural label (`"minutes"`). */
  plural: string
}

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
/** Calendar-month approximation — good enough for "2 months ago" copy. */
const MONTH = 30 * DAY
const YEAR = 365 * DAY

const THRESHOLDS: ReadonlyArray<Threshold> = [
  { upTo: HOUR, perUnit: MINUTE, singular: 'minute', plural: 'minutes' },
  { upTo: DAY, perUnit: HOUR, singular: 'hour', plural: 'hours' },
  { upTo: WEEK, perUnit: DAY, singular: 'day', plural: 'days' },
  { upTo: MONTH, perUnit: WEEK, singular: 'week', plural: 'weeks' },
  { upTo: YEAR, perUnit: MONTH, singular: 'month', plural: 'months' },
]

/**
 * Format a unix-ms timestamp as a relative-time string.
 *
 * @param timestamp Unix milliseconds (e.g. `Project.lastOpenedAt`).
 * @param now       Reference time, defaults to `Date.now()`. Inject for tests.
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const delta = now - timestamp

  // Future timestamps and sub-minute deltas both round to "just now".
  if (delta < MINUTE) return 'just now'

  // Special-case "yesterday" so 26h doesn't render as "1 day ago".
  // Anything inside the second calendar window but under 48h gets the
  // friendlier phrase.
  if (delta >= DAY && delta < 2 * DAY) return 'yesterday'

  for (const t of THRESHOLDS) {
    if (delta < t.upTo) {
      const n = Math.floor(delta / t.perUnit)
      return `${n} ${n === 1 ? t.singular : t.plural} ago`
    }
  }

  const years = Math.floor(delta / YEAR)
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}
