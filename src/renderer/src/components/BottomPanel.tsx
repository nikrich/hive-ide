/**
 * Hive IDE — bottom panel.
 *
 * Three-tabbed status surface that sits beneath the editor:
 *   - Terminal   : a faux shell session mirroring `hive status` / `hive logs`
 *   - manager.log: rows from the seed `log` plus a live "waiting" trailer
 *   - Problems   : warn / info rows that open files in the editor when clicked
 *
 * Tab selection state is owned by the parent (the App shell) and threaded
 * through here as `tab` / `setTab` — this component is purely presentational
 * over the data it is given.
 *
 * The markup mirrors the prototype in `design-reference/panels.jsx` so the
 * existing CSS in `styles/ide.css` (`.panel`, `.panel-*`, `.term*`, `.mlog*`,
 * `.prob*`) lights it up unchanged.
 */

import { Icon } from './primitives'
import type { LogLine, Problem } from '../data/seed'

/** The three tabs of the bottom panel. Lifted state owned by the parent. */
export type BottomPanelTab = 'terminal' | 'log' | 'problems'

export interface BottomPanelProps {
  /** Currently selected tab. */
  tab: BottomPanelTab
  /** Setter for the selected tab — called when the user clicks a tab button. */
  setTab: (tab: BottomPanelTab) => void
  /** Called when the user clicks the close (×) button in the tab strip. */
  onClose: () => void
  /** Called with a file path when the user clicks a Problems row. */
  onOpenFile: (file: string) => void
  /** Manager log lines to render under the `manager.log` tab. */
  log: LogLine[]
  /** Problem rows to render under the `Problems` tab. */
  problems: Problem[]
}

interface TabDef {
  k: BottomPanelTab
  l: string
  icon: string
  cnt?: number
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/**
 * Faux shell session — the same scripted `hive status` / `hive logs` output
 * the prototype shows. Static markup; no props needed.
 */
function Terminal() {
  return (
    <div className="term">
      <div className="line">
        <span className="p">acme/web-dashboard</span>{' '}
        <span className="dim">feat/oauth2 $</span> hive status
      </div>
      <div className="line dim">
        Reading mempalace · drawer: requirements, stories, agents, escalations…
      </div>
      <div className="line"> </div>
      <div className="line">
        <span className="ok">●</span> REQ-001  OAuth2 with Google &amp; GitHub{' '}
        <span className="dim">running · tick 184</span>
      </div>
      <div className="line">  3 worktrees · 14/31 pts done · PR #218 in review</div>
      <div className="line"> </div>
      <div className="line">
        <span className="p">acme/web-dashboard</span>{' '}
        <span className="dim">feat/oauth2 $</span> hive logs --follow im-7c3a
      </div>
      <div className="line ok">✓ Intermediate spawned — analyzing STORY-002…</div>
      <div className="line">→ editing src/lib/oauth.ts (Google provider exchange)</div>
      <div className="line">
        <span className="dim">…streaming</span> <span className="cur" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// manager.log
// ---------------------------------------------------------------------------

interface ManagerLogProps {
  log: LogLine[]
}

/**
 * Renders the seeded manager-tick log followed by a live "waiting for next
 * tick" trailer with a blinking cursor — same shape as `panels.jsx`.
 */
function ManagerLog({ log }: ManagerLogProps) {
  return (
    <div className="mlog">
      {log.map((l, i) => (
        <div className="ll" key={i}>
          <span className="tm">{l.t}</span>
          <span className={'tx ' + (l.cls || '')}>{l.txt}</span>
        </div>
      ))}
      <div className="ll">
        <span className="tm">live</span>
        <span className="tx dim">
          waiting for next tick · 00:38{' '}
          <span className="cur" style={{ background: 'var(--fg-3)' }} />
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

interface ProblemsProps {
  problems: Problem[]
  onOpenFile: (file: string) => void
}

/**
 * Lint-style problem rows. Clicking a row asks the editor to open that file
 * — the parent decides what "open" means (focus tab, jump to line, etc.).
 */
function Problems({ problems, onOpenFile }: ProblemsProps) {
  return (
    <div className="prob">
      {problems.map((p, i) => (
        <div
          className={'prob-row ' + p.sev}
          key={i}
          onClick={() => onOpenFile(p.file)}
        >
          <span className="pi">
            <Icon name={p.sev === 'warn' ? 'alert-triangle' : 'info'} />
          </span>
          <div>
            <div className="pm">{p.msg}</div>
            <div className="pl">
              {p.file}:{p.line}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// BottomPanel
// ---------------------------------------------------------------------------

export function BottomPanel({
  tab,
  setTab,
  onClose,
  onOpenFile,
  log,
  problems,
}: BottomPanelProps) {
  const tabs: TabDef[] = [
    { k: 'terminal', l: 'Terminal', icon: 'square-terminal' },
    { k: 'log', l: 'manager.log', icon: 'scroll-text' },
    { k: 'problems', l: 'Problems', icon: 'alert-triangle', cnt: problems.length },
  ]

  return (
    <section className="panel">
      <div className="panel-tabs">
        {tabs.map((t) => (
          <button
            key={t.k}
            className={'panel-tab' + (tab === t.k ? ' active' : '')}
            onClick={() => setTab(t.k)}
            type="button"
          >
            <Icon name={t.icon} size={14} /> {t.l}
            {t.cnt ? <span className="cnt">{t.cnt}</span> : null}
          </button>
        ))}
        <div className="panel-actions">
          <button className="ib" title="Split" type="button">
            <Icon name="columns-2" />
          </button>
          <button className="ib" title="Close panel" onClick={onClose} type="button">
            <Icon name="x" />
          </button>
        </div>
      </div>
      <div className="panel-body">
        {tab === 'terminal' && <Terminal />}
        {tab === 'log' && <ManagerLog log={log} />}
        {tab === 'problems' && <Problems problems={problems} onOpenFile={onOpenFile} />}
      </div>
    </section>
  )
}
