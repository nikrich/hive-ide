/**
 * Hive IDE — Pull requests view.
 *
 * One of the routes the App shell renders. Takes the seeded `prs` list and
 * renders the inline-styled PR rows from `design-reference/hub.jsx` — same
 * markup, ported to typed React with our shared primitives:
 *
 *   - `Btn`        for the outline "Open on GitHub" header action
 *   - `Icon`       for the PR-status icon and checks-state icon
 *   - `RoleAva`    for the author role avatar
 *   - `StatusChip` for the right-aligned PR-state chip
 *
 * The class hooks (`view`, `phead`, `phead-row`, `eyebrow`, `sub`,
 * `meta-mono`, `card`) all resolve against the existing CSS in
 * `styles/ide.css`, so this component lights up unchanged with the rest of
 * the IDE chrome.
 */

import { ROLE, type PullRequest } from '../data/seed'
import { Btn, Icon, RoleAva, StatusChip } from './primitives'

/** Label shown in the page eyebrow — matches `HIVE_PROJECT_LABEL` in hub.jsx. */
const HIVE_PROJECT_LABEL = 'acme/hive-ide'

/**
 * Per-PR-status icon + colour token. Keyed by `PrStatus` so adding a new
 * status to the union forces this map to be updated.
 */
const PR_ICON: Record<PullRequest['status'], { icon: string; color: string }> = {
  review: { icon: 'git-pull-request', color: 'var(--status-review)' },
  merged: { icon: 'git-merge', color: 'var(--status-merged)' },
}

/**
 * Per-checks-status colour token for the inline "checks <state>" line.
 * Keyed by `ChecksStatus` for the same exhaustiveness reason as PR_ICON.
 */
const CHECKS_COLOR: Record<PullRequest['checks'], string> = {
  running: 'var(--status-pending)',
  passed: 'var(--status-done)',
}

/** Icon shown next to the "checks <state>" line. */
const CHECKS_ICON: Record<PullRequest['checks'], string> = {
  running: 'loader',
  passed: 'check-circle-2',
}

export interface PRsViewProps {
  /** Callback for opening a file path — kept on the surface for parity with
   *  the other route components (e.g. `BottomPanel`), even though the
   *  current PR rows don't surface file links yet. */
  onOpenFile: (file: string) => void
  /** Seeded PR list to render. */
  prs: PullRequest[]
}

export function PRsView({ onOpenFile: _onOpenFile, prs }: PRsViewProps) {
  return (
    <div className="view">
      <div className="phead">
        <div className="phead-row">
          <div>
            <div className="eyebrow">{HIVE_PROJECT_LABEL}</div>
            <h1>Pull requests</h1>
            <div className="sub">
              PRs Hive opened on your remote, each linked to the stories that
              produced it.
            </div>
          </div>
          <Btn kind="outline" icon="external-link">
            Open on GitHub
          </Btn>
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
        {prs.map((pr) => {
          const { icon, color } = PR_ICON[pr.status]
          return (
            <div
              key={pr.num}
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
                    #{pr.num}
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

                  <span style={{ font: 'var(--t-code-sm)' }}>
                    <span style={{ color: 'var(--diff-add-fg)' }}>
                      +{pr.add}
                    </span>{' '}
                    <span style={{ color: 'var(--diff-del-fg)' }}>
                      −{pr.del}
                    </span>
                  </span>

                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      font: 'var(--t-meta)',
                      color: CHECKS_COLOR[pr.checks],
                    }}
                  >
                    <Icon name={CHECKS_ICON[pr.checks]} size={13} /> checks{' '}
                    {pr.checks}
                  </span>
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
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
