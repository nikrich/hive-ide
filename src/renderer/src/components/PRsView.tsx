/**
 * Hive IDE — Pull requests view.
 *
 * One of the routes the App shell renders. Takes live `PrCard`s derived from
 * the hive snapshot (stories carrying a `prUrl`, see `lib/hiveView.toPrCards`)
 * and renders the inline-styled PR rows from `design-reference/hub.jsx` —
 * same markup, ported to typed React with our shared primitives:
 *
 *   - `Btn`        for the per-row outline "Open" action and header Refresh
 *   - `Icon`       for the PR-status icon
 *   - `RoleAva`    for the author role avatar
 *   - `StatusChip` for the right-aligned PR-state chip
 *
 * On mount (and on Refresh) the view asks `window.hive.github.enrichPrs` for
 * live GitHub data per PR URL — state/draft, checks rollup, +/− diffstat,
 * review decision — and layers it onto the cards. Without a credential (or
 * without the bridge at all) every value comes back null and the cards render
 * exactly as before, plus a one-line hint when enrichment was attempted but
 * yielded nothing.
 *
 * The class hooks (`view`, `phead`, `phead-row`, `eyebrow`, `sub`,
 * `meta-mono`, `card`) all resolve against the existing CSS in
 * `styles/ide.css`, so this component lights up unchanged with the rest of
 * the IDE chrome.
 */

import { useCallback, useEffect, useState } from 'react'

import type { PrEnrichment } from '../../../types/github'
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

/**
 * Live PR state → StatusChip props.
 *
 * Checked `StatusChip` before wiring this: its `StatusKey` union is
 * `running | pending | review | blocked | merged | done | idle` (no
 * `open`/`closed`), but it accepts a `label` override — so instead of the
 * planned inline `.req-pill` fallback span we borrow the nearest tokens:
 * `review` (purple) labelled "open" and `blocked` (red, matching GitHub's
 * closed-PR red) labelled "closed". `merged` maps natively.
 */
const LIVE_CHIP: Record<
  PrEnrichment['state'],
  { status: 'review' | 'merged' | 'blocked'; label?: string }
> = {
  open: { status: 'review', label: 'open' },
  merged: { status: 'merged' },
  closed: { status: 'blocked', label: 'closed' },
}

/** Checks-rollup label + colour token per `PrEnrichment['checks']` value. */
const CHECKS_META: Record<NonNullable<PrEnrichment['checks']>, { label: string; color: string }> =
  {
    passing: { label: 'checks passing', color: 'var(--status-done)' },
    failing: { label: 'checks failing', color: 'var(--diff-del-fg)' },
    pending: { label: 'checks pending', color: 'var(--status-pending)' },
  }

/** Review-decision label per `PrEnrichment['reviewDecision']` value. */
const REVIEW_LABEL: Record<NonNullable<PrEnrichment['reviewDecision']>, string> = {
  approved: 'approved',
  'changes-requested': 'changes requested',
  'review-required': 'review required',
}

export interface PRsViewProps {
  /** Live PR cards derived from the hive snapshot. */
  prs: PrCard[]
  /** Eyebrow label — the active project name. */
  projectLabel: string
}

export function PRsView({ prs, projectLabel }: PRsViewProps) {
  const [enrichment, setEnrichment] = useState<Record<string, PrEnrichment | null>>({})
  const [hint, setHint] = useState(false)
  const urlsKey = prs.map((p) => p.url).join('\n')

  const refresh = useCallback(() => {
    const bridge = window.hive?.github
    const urls = urlsKey === '' ? [] : urlsKey.split('\n')
    if (!bridge || urls.length === 0) return () => {}
    let cancelled = false
    void bridge
      .enrichPrs(urls)
      .then((map) => {
        if (cancelled) return
        setEnrichment(map)
        setHint(Object.values(map).every((v) => v === null))
      })
      .catch(() => {
        if (!cancelled) setHint(true)
      })
    return () => {
      cancelled = true
    }
  }, [urlsKey])

  useEffect(() => refresh(), [refresh])

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
            {hint && prs.length > 0 && (
              <div className="sub" style={{ marginTop: 4 }}>
                Live GitHub status unavailable — sign in with gh or set
                github.token in Settings.
              </div>
            )}
          </div>
          {/* Btn has no `title` prop — the tooltip lives on a wrapper span. */}
          <span title="Re-check GitHub (results cached ~60s)">
            <Btn kind="outline" icon="refresh-cw" onClick={() => void refresh()}>
              Refresh
            </Btn>
          </span>
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
          const live = enrichment[pr.url] ?? null
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

                  {live !== null && (
                    <>
                      {live.isDraft && <span className="meta-mono">Draft</span>}
                      <span className="meta-mono">
                        <span style={{ color: 'var(--diff-add-fg)' }}>
                          +{live.additions}
                        </span>{' '}
                        <span style={{ color: 'var(--diff-del-fg)' }}>
                          −{live.deletions}
                        </span>
                      </span>
                      {live.checks !== null && (
                        <span
                          className="meta-mono"
                          style={{ color: CHECKS_META[live.checks].color }}
                        >
                          {CHECKS_META[live.checks].label}
                        </span>
                      )}
                      {live.reviewDecision !== null && (
                        <span className="meta-mono">
                          {REVIEW_LABEL[live.reviewDecision]}
                        </span>
                      )}
                    </>
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
                {live !== null ? (
                  <StatusChip
                    status={LIVE_CHIP[live.state].status}
                    label={LIVE_CHIP[live.state].label}
                  />
                ) : (
                  <StatusChip status={pr.status} />
                )}
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
