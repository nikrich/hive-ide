/**
 * Projects hub view — top-level cross-project landing route.
 *
 * Renders a header, a four-card stats row (Projects / Active runs / Agents
 * live / Escalations) and a responsive grid of project cards. Clicking a
 * card calls `onEnter(id)`. The card whose id matches `currentId` shows a
 * "currently open" marker.
 *
 * Ports `design-reference/hub.jsx` (`ProjectsHub` + `statusColor`) into the
 * TypeScript renderer. CSS lives in `styles/ide.css` under `.view`, `.phead`,
 * `.stats`, `.hub-grid`, `.pcard`.
 */

import type { Project } from '../data/seed'
import { Btn, Icon, Pulse, StatusChip } from './primitives'

/**
 * Map a project/story status string to the CSS-var colour used for the dot
 * inside a project card. Falls back to `--fg-3` for unknown values so the
 * UI degrades gracefully rather than rendering an empty dot.
 *
 * Exported so other views (e.g. roster, story rows) can share the mapping.
 */
export function statusColor(s: string): string {
  const map: Record<string, string> = {
    running: 'var(--status-running)',
    review: 'var(--status-review)',
    blocked: 'var(--status-blocked)',
    idle: 'var(--fg-3)',
    done: 'var(--status-done)',
  }
  return map[s] ?? 'var(--fg-3)'
}

export interface ProjectsHubProps {
  /** Called when the operator clicks a project card. */
  onEnter: (id: string) => void
  /** Id of the project currently open in the editor, if any. */
  currentId?: string
  /** Projects to render as cards. */
  projects: Project[]
}

export function ProjectsHub({ onEnter, currentId, projects }: ProjectsHubProps) {
  const totalAgents = projects.reduce((a, p) => a + p.agents, 0)
  const running = projects.filter((p) => p.status === 'running').length
  const blocked = projects.filter((p) => p.status === 'blocked').length

  return (
    <div className="view">
      <div className="phead">
        <div className="phead-row">
          <div>
            <div className="eyebrow">Workspace</div>
            <h1>Projects</h1>
            <div className="sub">
              Every repo Hive is orchestrating. Open one to drop into its editor and live run.
            </div>
          </div>
          <Btn kind="amber" icon="plus">New orchestration</Btn>
        </div>
      </div>

      <div className="stats">
        <div className="card stat">
          <div className="n">{projects.length}</div>
          <div className="l">Projects</div>
        </div>
        <div className="card stat">
          <div className="n" style={{ color: 'var(--status-running)' }}>{running}</div>
          <div className="l">Active runs</div>
        </div>
        <div className="card stat">
          <div className="n" style={{ color: 'var(--teal-400)' }}>{totalAgents}</div>
          <div className="l">Agents live</div>
        </div>
        <div className="card stat">
          <div
            className="n"
            style={{ color: blocked ? 'var(--status-blocked)' : 'var(--fg-1)' }}
          >
            {blocked}
          </div>
          <div className="l">Escalations</div>
        </div>
      </div>

      <div className="hub-grid">
        {projects.map((p) => {
          const hasDelim = p.req.includes(' · ')
          const [reqId, reqRest] = hasDelim ? p.req.split(' · ') : ['', p.req]
          return (
            <div
              key={p.id}
              className="card click pcard"
              onClick={() => onEnter(p.id)}
            >
              <div className="pcard-top">
                <div>
                  <div className="pn">
                    <span
                      className="proj-dot"
                      style={{ background: statusColor(p.status) }}
                    />
                    {p.name}
                  </div>
                  <div className="stack">{p.stack}</div>
                </div>
                <StatusChip status={p.status} />
              </div>

              <div className="req">
                {hasDelim ? (
                  <>
                    <span className="rid">{reqId}</span> · {reqRest}
                  </>
                ) : (
                  p.req
                )}
              </div>

              <div className="pcard-foot">
                <span className="brn">
                  <Icon name="git-branch" size={13} /> {p.branch}
                </span>
                {p.agents > 0 ? (
                  <span
                    style={{
                      font: 'var(--t-body-sm)',
                      color: 'var(--fg-2)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                    }}
                  >
                    {p.status === 'running' && <Pulse />}
                    {p.agents} agents · {p.runs} run{p.runs !== 1 ? 's' : ''}
                  </span>
                ) : (
                  <span style={{ font: 'var(--t-body-sm)', color: 'var(--fg-3)' }}>
                    idle
                  </span>
                )}
              </div>

              {currentId === p.id && (
                <div
                  style={{
                    marginTop: 12,
                    font: 'var(--t-meta)',
                    color: 'var(--accent-text)',
                    textTransform: 'uppercase',
                    letterSpacing: 'var(--tr-eyebrow)',
                  }}
                >
                  ● currently open
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
