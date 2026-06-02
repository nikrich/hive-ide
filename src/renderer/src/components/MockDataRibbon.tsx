/**
 * Hive IDE — shared "mock data" ribbon.
 *
 * Subtle one-line banner rendered at the top of any surface that is still
 * driven by `data/seed.ts` rather than a real Hive backend feed. Today that
 * is the agent {@link AgentDock} and the {@link BottomPanel}; future REQs will
 * flip the text from this single module so callers do not need to be touched.
 *
 * Intentionally low-key:
 *   - muted foreground (`--fg-3`)
 *   - subtle bottom border to separate it from the surface below
 *   - meta-sized type (`--t-meta`)
 *
 * The text lives in {@link MOCK_DATA_RIBBON_TEXT} so that future requirements
 * can replace it in one place without touching every consumer.
 */

import type { CSSProperties } from 'react'

/** Single source of truth for the ribbon copy. */
export const MOCK_DATA_RIBBON_TEXT = 'mock data — Hive not connected'

const RIBBON_STYLE: CSSProperties = {
  padding: '4px 12px',
  font: 'var(--t-meta)',
  color: 'var(--fg-3)',
  background: 'var(--border-subtle)',
  borderBottom: '1px solid var(--border-subtle)',
  letterSpacing: '0.02em',
  flexShrink: 0,
}

export function MockDataRibbon() {
  return (
    <div
      role="note"
      aria-label="mock data notice"
      className="mock-data-ribbon"
      style={RIBBON_STYLE}
    >
      {MOCK_DATA_RIBBON_TEXT}
    </div>
  )
}

export default MockDataRibbon
