/**
 * Hunk action strip for diff tabs (E7-02).
 *
 * Renders one row per parsed diff hunk with a Stage/Unstage action. The host
 * (DiffTabHost) owns the git side effects; this component is presentational
 * so it stays unit-testable without IPC.
 */

import type { ReactElement } from 'react'

import type { DiffHunk } from '../lib/diffHunks'
import { Icon } from './primitives'

export interface DiffHunkBarProps {
  hunks: DiffHunk[]
  /** 'stage' on working-tree diffs, 'unstage' on index diffs. */
  mode: 'stage' | 'unstage'
  /** Index of the hunk currently being applied, or null when idle. */
  busyIndex: number | null
  onApply: (index: number) => void
}

export function DiffHunkBar({ hunks, mode, busyIndex, onApply }: DiffHunkBarProps): ReactElement | null {
  if (hunks.length === 0) return null
  const verb = mode === 'stage' ? 'Stage' : 'Unstage'
  return (
    <div className="hunkbar" role="toolbar" aria-label="Diff hunks">
      {hunks.map((h, i) => {
        const adds = h.lines.filter((l) => l.startsWith('+')).length
        const dels = h.lines.filter((l) => l.startsWith('-')).length
        return (
          <div key={`${h.header}-${i}`} className="hunkbar-row">
            <span className="hunkbar-meta meta-mono">
              {h.header.replace(/@@/g, '').trim()}
              {'  '}
              <span style={{ color: 'var(--diff-add-fg)' }}>+{adds}</span>{' '}
              <span style={{ color: 'var(--diff-del-fg)' }}>−{dels}</span>
            </span>
            <button
              type="button"
              className="srch-opt"
              disabled={busyIndex !== null}
              aria-label={`${verb} hunk ${i + 1}`}
              title={`${verb} this hunk`}
              onClick={() => onApply(i)}
            >
              <Icon name={mode === 'stage' ? 'plus' : 'minus'} size={13} />
              {busyIndex === i ? `${verb.replace(/e$/, '')}ing…` : `${verb} hunk`}
            </button>
          </div>
        )
      })}
    </div>
  )
}
