/**
 * TerminalView — full-screen, Warp-style terminal workspace.
 *
 * Layout (design `terminal.jsx`, adapted to real shells):
 *
 *   ┌ Sessions ─────┬───────── stage ─────────────────────────────┐
 *   │ acme-web      │ ┌─ pane (real zsh) ──┬─ pane (real zsh) ──┐  │
 *   │  ▸ web        │ │ $ git log          │ $ pnpm test        │  │
 *   │ Local         │ │ …                  │ …                  │  │
 *   │  ▸ zsh        │ ├────────────────────┴────────────────────┤  │
 *   │               │ │  ~/dev/acme        main                  │  │
 *   └───────────────┴─────────────────────────────────────────────┘
 *
 * Each pane is a *real* node-pty/xterm shell ({@link XtermPane}) — not a
 * mock transcript. The design's pane chrome (header with split/close, a
 * footer with cwd + branch chips) wraps a working terminal.
 *
 * Sessions persist across view switches: App.tsx keeps this component
 * mounted (hidden via `display:none`) once the terminal has been opened, and
 * every pane in every session stays mounted so scrollback / running
 * processes survive both session switches and tab navigation. Inactive
 * sessions are hidden, not torn down.
 *
 * Keyboard (only while the view is active):
 *   ⌘T new session · ⌘D split right · ⌘⇧D split down · ⌘W close pane ·
 *   ⌘1–9 switch session · ⌥←/→ move pane focus.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { Icon } from './primitives'
import { XtermPane } from './XtermPane'
import type { Project } from '../../../types/workspace'

// ---------------------------------------------------------------------------
// Tree model
// ---------------------------------------------------------------------------

/** A leaf (one terminal) or a binary split of two child nodes. */
type PaneNode =
  | { type: 'pane'; id: string }
  | {
      type: 'split'
      id: string
      dir: 'row' | 'col'
      /** Flex-grow weights for [a, b]; always sums to 100. */
      sizes: [number, number]
      a: PaneNode
      b: PaneNode
    }

/** Per-pane metadata (the shell's identity), keyed by pane id. */
interface PaneMeta {
  id: string
  title: string
  cwd: string | undefined
  /** Display label for the footer branch chip (repo name / `~`). */
  branch: string
  exited?: boolean
}

/** A session = a named pane tree shown as one entry in the rail. */
interface Session {
  id: string
  /** Rail grouping bucket (project name or "Local"). */
  group: string
  title: string
  branch: string
  root: PaneNode
  activePane: string
}

// ---------------------------------------------------------------------------
// id generation + tree helpers
// ---------------------------------------------------------------------------

let SEQ = 1
const uid = (p: string): string => `${p}_${SEQ++}`

function leaves(n: PaneNode): Array<{ id: string }> {
  return n.type === 'pane' ? [n] : [...leaves(n.a), ...leaves(n.b)]
}

/** Replace the leaf with id `id` by `fn(leaf)`, returning a new tree. */
function replaceLeaf(
  n: PaneNode,
  id: string,
  fn: (leaf: PaneNode) => PaneNode,
): PaneNode {
  if (n.type === 'pane') return n.id === id ? fn(n) : n
  return { ...n, a: replaceLeaf(n.a, id, fn), b: replaceLeaf(n.b, id, fn) }
}

/** Remove the leaf with id `id`, collapsing its now-only-child split. */
function removeLeaf(n: PaneNode, id: string): PaneNode | null {
  if (n.type === 'pane') return n.id === id ? null : n
  const a = removeLeaf(n.a, id)
  const b = removeLeaf(n.b, id)
  if (a === null) return b
  if (b === null) return a
  return { ...n, a, b }
}

/** Update a split node's sizes by split id. */
function sizeSplit(
  n: PaneNode,
  id: string,
  sizes: [number, number],
): PaneNode {
  if (n.type === 'pane') return n
  if (n.id === id) return { ...n, sizes }
  return { ...n, a: sizeSplit(n.a, id, sizes), b: sizeSplit(n.b, id, sizes) }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface TerminalViewProps {
  /** True when this view is the foreground view (drives keyboard + focus). */
  active: boolean
  /** The active project, used to seed the first session's cwd + grouping. */
  project: Project | null
}

interface SeedState {
  sessions: Session[]
  panes: Record<string, PaneMeta>
}

export function TerminalView({ active, project }: TerminalViewProps) {
  // Seed exactly one session on first mount. cwd = first repo (or home).
  const seedRef = useRef<SeedState | null>(null)
  if (!seedRef.current) {
    const repo = project?.repos[0]
    const pid = uid('pane')
    const meta: PaneMeta = {
      id: pid,
      title: project?.name ?? 'zsh',
      cwd: repo?.path,
      branch: repo?.name ?? '~',
    }
    const sess: Session = {
      id: uid('sess'),
      group: project?.name ?? 'Local',
      title: project?.name ?? 'zsh',
      branch: repo?.name ?? '~',
      root: { type: 'pane', id: pid },
      activePane: pid,
    }
    seedRef.current = { sessions: [sess], panes: { [pid]: meta } }
  }
  const seed = seedRef.current

  const [sessions, setSessions] = useState<Session[]>(seed.sessions)
  const [panes, setPanes] = useState<Record<string, PaneMeta>>(seed.panes)
  const [activeId, setActiveId] = useState<string>(seed.sessions[0].id)
  const [query, setQuery] = useState('')

  const activeSession =
    sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null

  // ----- pane / session mutations ---------------------------------------

  const registerPane = useCallback(
    (cwd: string | undefined, branch: string, title: string): string => {
      const id = uid('pane')
      setPanes((prev) => ({
        ...prev,
        [id]: { id, title, cwd, branch },
      }))
      return id
    },
    [],
  )

  const focusPane = useCallback(
    (paneId: string) => {
      setSessions((ss) =>
        ss.map((s) => (s.id === activeId ? { ...s, activePane: paneId } : s)),
      )
    },
    [activeId],
  )

  const splitPane = useCallback(
    (paneId: string, dir: 'row' | 'col') => {
      const src = panes[paneId]
      const newId = registerPane(
        src?.cwd,
        src?.branch ?? '~',
        src?.title ?? 'zsh',
      )
      setSessions((ss) =>
        ss.map((s) => {
          if (s.id !== activeId) return s
          const root = replaceLeaf(s.root, paneId, (old) => ({
            type: 'split',
            id: uid('split'),
            dir,
            sizes: [50, 50],
            a: old,
            b: { type: 'pane', id: newId },
          }))
          return { ...s, root, activePane: newId }
        }),
      )
    },
    [activeId, panes, registerPane],
  )

  const closePane = useCallback(
    (paneId: string) => {
      setSessions((ss) => {
        const s = ss.find((x) => x.id === activeId)
        if (!s) return ss
        const ls = leaves(s.root)
        // Last pane in the session → close the whole session (unless it's
        // the only session left).
        if (ls.length === 1) {
          if (ss.length === 1) return ss
          const idx = ss.findIndex((x) => x.id === activeId)
          const next = ss[idx + 1] ?? ss[idx - 1]
          setActiveId(next.id)
          return ss.filter((x) => x.id !== activeId)
        }
        const root = removeLeaf(s.root, paneId)
        if (root === null) return ss
        return ss.map((x) =>
          x.id === activeId
            ? { ...x, root, activePane: leaves(root)[0].id }
            : x,
        )
      })
    },
    [activeId],
  )

  const resizeSplit = useCallback(
    (splitId: string, sizes: [number, number]) => {
      setSessions((ss) =>
        ss.map((s) =>
          s.id === activeId
            ? { ...s, root: sizeSplit(s.root, splitId, sizes) }
            : s,
        ),
      )
    },
    [activeId],
  )

  const markExited = useCallback((paneId: string) => {
    setPanes((prev) =>
      prev[paneId] ? { ...prev, [paneId]: { ...prev[paneId], exited: true } } : prev,
    )
  }, [])

  const newSession = useCallback(() => {
    const repo = project?.repos[0]
    const id = registerPane(repo?.path, repo?.name ?? '~', repo?.name ?? 'zsh')
    const sid = uid('sess')
    setSessions((ss) => [
      ...ss,
      {
        id: sid,
        group: project?.name ?? 'Local',
        title: project?.name ? `${project.name} · shell` : 'zsh',
        branch: repo?.name ?? '~',
        root: { type: 'pane', id },
        activePane: id,
      },
    ])
    setActiveId(sid)
  }, [project, registerPane])

  const moveFocus = useCallback(
    (delta: number) => {
      setSessions((ss) =>
        ss.map((s) => {
          if (s.id !== activeId) return s
          const ls = leaves(s.root)
          const i = ls.findIndex((l) => l.id === s.activePane)
          const next = ls[(i + delta + ls.length) % ls.length]
          return { ...s, activePane: next.id }
        }),
      )
    },
    [activeId],
  )

  // ----- keyboard shortcuts (only while the view is active) -------------
  useEffect(() => {
    if (!active) return
    function onKey(e: KeyboardEvent): void {
      const meta = e.metaKey || e.ctrlKey
      if (e.altKey && !meta && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        moveFocus(e.key === 'ArrowRight' ? 1 : -1)
        return
      }
      if (!meta) return
      const k = e.key.toLowerCase()
      const ap = activeSession?.activePane
      if (k === 't') {
        e.preventDefault()
        newSession()
      } else if (k === 'd' && e.shiftKey) {
        e.preventDefault()
        if (ap) splitPane(ap, 'col')
      } else if (k === 'd') {
        e.preventDefault()
        if (ap) splitPane(ap, 'row')
      } else if (k === 'w') {
        e.preventDefault()
        if (ap) closePane(ap)
      } else if (/^[1-9]$/.test(k)) {
        const i = parseInt(k, 10) - 1
        if (sessions[i]) {
          e.preventDefault()
          setActiveId(sessions[i].id)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, activeSession, sessions, newSession, splitPane, closePane, moveFocus])

  // ----- rail grouping --------------------------------------------------
  const groups = useMemo(() => {
    const order: string[] = []
    const byGroup: Record<string, Session[]> = {}
    for (const s of sessions) {
      if (!byGroup[s.group]) {
        byGroup[s.group] = []
        order.push(s.group)
      }
      byGroup[s.group].push(s)
    }
    return { order, byGroup }
  }, [sessions])

  const ql = query.trim().toLowerCase()
  const matches = (s: Session): boolean =>
    ql === '' || `${s.title} ${s.branch} ${s.group}`.toLowerCase().includes(ql)

  const handlers: PaneHandlers = {
    focus: focusPane,
    split: splitPane,
    close: closePane,
    resize: resizeSplit,
    exit: markExited,
  }

  return (
    <div className="termview" style={{ display: active ? 'grid' : 'none' }}>
      {/* session rail */}
      <aside className="cc-rail">
        <div className="cc-rail-top">
          <div className="cc-search">
            <Icon name="search" size={13} />
            <input
              value={query}
              placeholder="Search sessions…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className="cc-railadd"
            title="New session (⌘T)"
            type="button"
            onClick={newSession}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>

        <div className="cc-rail-list">
          {groups.order.map((g) => {
            const items = groups.byGroup[g].filter(matches)
            if (items.length === 0) return null
            return (
              <div className="cc-grp" key={g}>
                <div className="cc-grp-h">{g}</div>
                {items.map((s) => {
                  const pc = leaves(s.root).length
                  return (
                    <div
                      key={s.id}
                      className={'cc-sess' + (s.id === activeId ? ' active' : '')}
                      onClick={() => setActiveId(s.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setActiveId(s.id)
                        }
                      }}
                    >
                      <span className="cc-sess-dot" />
                      <div className="cc-sess-meta">
                        <div className="cc-sess-t">
                          <span className="cc-star">✳</span> {s.title}
                        </div>
                        <div className="cc-sess-b">
                          <Icon name="git-branch" size={11} /> {s.branch}
                        </div>
                      </div>
                      {pc > 1 && (
                        <span className="cc-sess-panes" title={`${pc} panes`}>
                          {pc}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="cc-rail-foot">
          <span>
            <b>⌘T</b> session
          </span>
          <span>
            <b>⌘D</b> split
          </span>
          <span>
            <b>⌘W</b> close
          </span>
        </div>
      </aside>

      {/* pane stage — every session kept mounted so shells survive switches */}
      <div className="cc-stage">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="cc-session-wrap"
            style={{ display: s.id === activeId ? 'flex' : 'none' }}
          >
            <PaneTree
              node={s.root}
              panes={panes}
              activePane={s.activePane}
              sessionActive={s.id === activeId && active}
              handlers={handlers}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pane tree rendering
// ---------------------------------------------------------------------------

interface PaneHandlers {
  focus: (paneId: string) => void
  split: (paneId: string, dir: 'row' | 'col') => void
  close: (paneId: string) => void
  resize: (splitId: string, sizes: [number, number]) => void
  exit: (paneId: string) => void
}

interface PaneTreeProps {
  node: PaneNode
  panes: Record<string, PaneMeta>
  activePane: string
  sessionActive: boolean
  handlers: PaneHandlers
}

function PaneTree({
  node,
  panes,
  activePane,
  sessionActive,
  handlers,
}: PaneTreeProps) {
  if (node.type === 'pane') {
    const meta = panes[node.id]
    return (
      <CCPane
        id={node.id}
        meta={meta}
        active={activePane === node.id}
        focused={sessionActive && activePane === node.id}
        handlers={handlers}
      />
    )
  }
  return (
    <div className={'cc-split cc-' + node.dir}>
      <div className="cc-slot" style={{ flexGrow: node.sizes[0], flexBasis: 0 }}>
        <PaneTree
          node={node.a}
          panes={panes}
          activePane={activePane}
          sessionActive={sessionActive}
          handlers={handlers}
        />
      </div>
      <CCDivider
        dir={node.dir}
        onResize={(s) => handlers.resize(node.id, s)}
      />
      <div className="cc-slot" style={{ flexGrow: node.sizes[1], flexBasis: 0 }}>
        <PaneTree
          node={node.b}
          panes={panes}
          activePane={activePane}
          sessionActive={sessionActive}
          handlers={handlers}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CCPane — one terminal pane with design chrome around a real xterm.
// ---------------------------------------------------------------------------

interface CCPaneProps {
  id: string
  meta: PaneMeta | undefined
  active: boolean
  focused: boolean
  handlers: PaneHandlers
}

function CCPane({ id, meta, active, focused, handlers }: CCPaneProps) {
  const title = meta?.title ?? 'zsh'
  const cwd = meta?.cwd
  const branch = meta?.branch ?? '~'
  const pathLabel = cwd ?? '~'

  return (
    <div
      className={'ccpane' + (active ? ' active' : '')}
      onMouseDown={() => handlers.focus(id)}
    >
      <div className="cc-head">
        <span className="cc-star">✳</span>
        <span className="cc-title">{title}</span>
        {meta?.exited && <span className="cc-exited">exited</span>}
        <span className="cc-spacer" />
        <button
          className="cc-hbtn"
          title="Split right (⌘D)"
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            handlers.split(id, 'row')
          }}
        >
          <Icon name="panel-right" size={14} />
        </button>
        <button
          className="cc-hbtn"
          title="Split down (⌘⇧D)"
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            handlers.split(id, 'col')
          }}
        >
          <Icon name="panel-bottom" size={14} />
        </button>
        <button
          className="cc-hbtn"
          title="Close pane (⌘W)"
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            handlers.close(id)
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="cc-term">
        <XtermPane cwd={cwd} focused={focused} onExit={() => handlers.exit(id)} />
      </div>

      <div className="cc-foot">
        <div className="cc-pathrow">
          <span className="cc-pathchip">
            <Icon name="folder" size={12} /> {pathLabel}
          </span>
          <span className="cc-pathchip">
            <Icon name="git-branch" size={12} /> {branch}
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CCDivider — draggable split divider.
// ---------------------------------------------------------------------------

interface CCDividerProps {
  dir: 'row' | 'col'
  onResize: (sizes: [number, number]) => void
}

function CCDivider({ dir, onResize }: CCDividerProps) {
  const ref = useRef<HTMLDivElement | null>(null)

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    const container = ref.current?.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()

    function move(ev: PointerEvent): void {
      const frac =
        dir === 'row'
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height
      const a = Math.min(0.82, Math.max(0.18, frac)) * 100
      onResize([a, 100 - a])
    }
    function up(): void {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.style.cursor = dir === 'row' ? 'col-resize' : 'row-resize'
  }

  return (
    <div
      ref={ref}
      className={'cc-divider cc-' + dir}
      onPointerDown={onPointerDown}
    />
  )
}

export default TerminalView
