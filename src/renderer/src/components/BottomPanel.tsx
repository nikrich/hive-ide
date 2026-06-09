/**
 * Hive IDE — bottom panel.
 *
 * Three-tabbed status surface that sits beneath the editor:
 *   - Terminal   : a real multi-tab xterm.js front-end backed by node-pty
 *                  in the main process — see `./Terminal.tsx` (REQ-004).
 *   - manager.log: live hive event rows (adapted via `lib/hiveView`) plus a
 *                  "waiting" trailer
 *   - Problems   : real LSP/TS diagnostic rows that open files in the editor
 *                  when clicked
 *
 * Tab selection state is owned by the parent (the App shell) and threaded
 * through here as `tab` / `setTab` — this component is purely presentational
 * over the data it is given.
 *
 * The markup mirrors the prototype in `design-reference/panels.jsx` so the
 * existing CSS in `styles/ide.css` (`.panel`, `.panel-*`, `.mlog*`, `.prob*`)
 * lights it up unchanged. Terminal CSS lives in the `.term-panel` block
 * appended to `ide.css` by REQ-004.
 */

import { useMemo, useState } from 'react'

import { Icon, fileIcon } from './primitives'
import { TerminalPanel } from './Terminal'
import type { LogLine } from '../data/seed'
import {
  countDiagnostics,
  useProblemsStore,
  type Diagnostic,
  type DiagnosticSeverity,
} from '../store/problemsStore'
import { useWorkspaceStore } from '../store/workspaceStore'

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
}

interface TabDef {
  k: BottomPanelTab
  l: string
  icon: string
  cnt?: number
}

// ---------------------------------------------------------------------------
// Terminal — real multi-tab xterm.js panel (REQ-004). See `./Terminal.tsx`.
// The prototype's faux-shell `Terminal()` lived here; it has been replaced
// with a node-pty-backed multi-tab implementation. The component manages
// its own tab state so this panel stays presentational.
// ---------------------------------------------------------------------------

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

const SEVERITY_ICON: Record<DiagnosticSeverity, string> = {
  error: 'x-circle',
  warning: 'alert-triangle',
  info: 'info',
  hint: 'lightbulb',
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
}

function basename(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/'
  const i = p.lastIndexOf(sep)
  return i === -1 ? p : p.slice(i + 1)
}

/**
 * Real Problems panel (E9-01) — aggregates LSP/TS diagnostics from the
 * problems store, grouped by file, severity-sorted, with optional severity +
 * text filtering (E9-05). Clicking a row reveals the diagnostic's line.
 */
function Problems() {
  const byFile = useProblemsStore((s) => s.byFile)
  const revealInFile = useWorkspaceStore((s) => s.revealInFile)
  const [filter, setFilter] = useState('')
  const [minSeverity, setMinSeverity] = useState<DiagnosticSeverity | 'all'>('all')

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const maxRank = minSeverity === 'all' ? 3 : SEVERITY_RANK[minSeverity]
    const entries: Array<{ file: string; diags: Diagnostic[] }> = []
    for (const [file, diags] of Object.entries(byFile)) {
      const filtered = diags
        .filter((d) => SEVERITY_RANK[d.severity] <= maxRank)
        .filter(
          (d) =>
            needle === '' ||
            d.message.toLowerCase().includes(needle) ||
            file.toLowerCase().includes(needle),
        )
        .sort(
          (a, b) =>
            SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
            a.line - b.line,
        )
      if (filtered.length > 0) entries.push({ file, diags: filtered })
    }
    entries.sort((a, b) => a.file.localeCompare(b.file))
    return entries
  }, [byFile, filter, minSeverity])

  if (Object.keys(byFile).length === 0) {
    return (
      <div className="prob">
        <div className="prob-empty">No problems have been detected.</div>
      </div>
    )
  }

  return (
    <div className="prob">
      <div className="prob-toolbar">
        <input
          className="prob-filter"
          value={filter}
          placeholder="Filter problems"
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter problems"
        />
        <select
          className="prob-sev"
          value={minSeverity}
          onChange={(e) =>
            setMinSeverity(e.target.value as DiagnosticSeverity | 'all')
          }
          aria-label="Minimum severity"
        >
          <option value="all">All</option>
          <option value="error">Errors</option>
          <option value="warning">Warnings & up</option>
          <option value="info">Info & up</option>
        </select>
      </div>
      {groups.length === 0 && (
        <div className="prob-empty">No problems match the filter.</div>
      )}
      {groups.map(({ file, diags }) => {
        const [icon, tint] = fileIcon(basename(file))
        return (
          <div key={file} className="prob-group">
            <div className="prob-filerow">
              <span className={'fi ' + tint}>
                <Icon name={icon} size={13} />
              </span>
              <span className="prob-filename">{basename(file)}</span>
              <span className="prob-count">{diags.length}</span>
            </div>
            {diags.map((d, i) => (
              <div
                // eslint-disable-next-line react/no-array-index-key
                key={i}
                className={'prob-row ' + d.severity}
                onClick={() => revealInFile(file, d.line, d.column)}
                role="button"
                tabIndex={0}
              >
                <span className="pi">
                  <Icon name={SEVERITY_ICON[d.severity]} size={14} />
                </span>
                <div className="prob-meta">
                  <div className="pm">{d.message}</div>
                  <div className="pl">
                    {d.source ? `${d.source} · ` : ''}Ln {d.line}, Col {d.column}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      })}
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
  log,
}: BottomPanelProps) {
  const problemsByFile = useProblemsStore((s) => s.byFile)
  const problemCount = useMemo(() => {
    const c = countDiagnostics(problemsByFile)
    return c.errors + c.warnings + c.infos + c.hints
  }, [problemsByFile])

  const tabs: TabDef[] = [
    { k: 'terminal', l: 'Terminal', icon: 'square-terminal' },
    { k: 'log', l: 'manager.log', icon: 'scroll-text' },
    { k: 'problems', l: 'Problems', icon: 'alert-triangle', cnt: problemCount },
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
        {/*
          The terminal stays MOUNTED across tab switches (hidden via display)
          so switching to manager.log / Problems doesn't dispose the ptys and
          kill a running shell. log / Problems are cheap and stay conditional.
        */}
        <div
          className="panel-pane"
          style={{ display: tab === 'terminal' ? 'flex' : 'none' }}
        >
          <TerminalPanel />
        </div>
        {tab === 'log' && <ManagerLog log={log} />}
        {tab === 'problems' && <Problems />}
      </div>
    </section>
  )
}
