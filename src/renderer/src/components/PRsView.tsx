/**
 * Hive IDE — Pull requests view.
 *
 * One of the routes the App shell renders. Takes live `PrCard`s derived from
 * the hive snapshot (stories carrying a `prUrl`, see `lib/hiveView.toPrCards`)
 * and renders the inline-styled PR rows from `design-reference/hub.jsx` —
 * same markup, ported to typed React with our shared primitives:
 *
 *   - `Btn`        for the per-row outline "Open" action
 *   - `Icon`       for the PR-status icon
 *   - `RoleAva`    for the author role avatar
 *   - `StatusChip` for the right-aligned PR-state chip
 *
 * The class hooks (`view`, `phead`, `phead-row`, `eyebrow`, `sub`,
 * `meta-mono`, `card`) all resolve against the existing CSS in
 * `styles/ide.css`, so this component lights up unchanged with the rest of
 * the IDE chrome.
 */

import { ROLE } from '../data/seed'
import type { PrCard } from '../lib/hiveView'
import { Btn, Icon, RoleAva, StatusChip } from './primitives'

/**
 * Per-PR-status icon + colour token. Keyed by `PrCard['status']` so adding a
 * new status to the union forces this map to be updated.
 */
const PR_ICON: Record<PrCard['status'], { icon: string; color: string }> = {
  review: { icon: 'git-pull-request', color: 'var(--status-review)' },
  merged: { icon: 'git-merge', color: 'var(--status-merged)' },
}

export interface PRsViewProps {
  /** Live PR cards derived from the hive snapshot. */
  prs: PrCard[]
  /** Eyebrow label — the active project name. */
  projectLabel: string
}

export function PRsView({ prs, projectLabel }: PRsViewProps) {
  return (
    <div className="view">
      <div className="phead">
        <div className="phead-row">
          <div>
            <div className="eyebrow">{projectLabel}</div>
            <h1>Pull requests</h1>
            <div className="sub">
              PRs Hive opened on your remote, derived live from stories that
              carry a PR URL.
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          padding: '6px 32px 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {prs.length === 0 && (
          <div className="srch-status">
            No pull requests yet — they appear here when hive stories carry a
            PR URL.
          </div>
        )}
        {prs.map((pr) => {
          const { icon, color } = PR_ICON[pr.status]
          return (
            <div
              key={pr.storyId}
              className="card"
              style={{
                padding: '16px 20px',
                display: 'grid',
                gridTemplateColumns: '24px 1fr auto',
                gap: 14,
                alignItems: 'start',
              }}
            >
              <span style={{ color, display: 'flex', marginTop: 2 }}>
                <Icon name={icon} size={19} />
              </span>

              <div>
                <div
                  style={{
                    font: '600 14.5px/1.35 var(--font-ui)',
                    color: 'var(--fg-1)',
                  }}
                >
                  <span
                    style={{
                      color: 'var(--fg-3)',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 500,
                    }}
                  >
                    {pr.num !== null ? `#${pr.num}` : pr.storyId}
                  </span>{' '}
                  {pr.title}
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    marginTop: 9,
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      font: 'var(--t-body-sm)',
                      color: 'var(--fg-2)',
                    }}
                  >
                    <RoleAva role={pr.role} size={20} /> {ROLE[pr.role].label}
                  </span>

                  {pr.branch !== '' && (
                    <span
                      className="meta-mono"
                      style={{
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--r-sm)',
                        padding: '2px 8px',
                      }}
                    >
                      {pr.branch}
                    </span>
                  )}
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                  gap: 9,
                }}
              >
                <StatusChip status={pr.status} />
                <span className="meta-mono">{pr.time}</span>
                <Btn
                  kind="outline"
                  sm
                  icon="external-link"
                  onClick={() => void window.hive?.shell?.openExternal(pr.url)}
                >
                  Open
                </Btn>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
