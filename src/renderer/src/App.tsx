/**
 * Hive IDE — application shell.
 *
 * Final assembly: composes every renderer component into the IDE shell,
 * owns the routing between the three top-level views (`ide` | `hub` | `prs`),
 * the project switcher, the keyboard shortcuts (⌘K / ⌘S / ⌘J), the bottom
 * panel + status bar, and the simulated live-agent streaming animation that
 * advances `contents[AGENT_FILE]` toward `AGENT_INCOMING`.
 *
 * Architectural decisions
 * -----------------------
 * - **Single shell owner.** All mutable IDE state (open tabs, dirty map,
 *   contents, active tab, view, project, panel state) lives in this file.
 *   Sibling components receive immutable props + callbacks so they stay pure
 *   renderers — none of them know about routing or the project switcher.
 * - **No tweaks panel.** The design-reference exposed a `TweaksPanel` for
 *   accent / density / dock / panel toggles. STORY-014 explicitly drops it;
 *   accent is fixed to indigo via the `data-accent` attribute, panel + dock
 *   visibility is plain component state, density stays at "comfortable".
 * - **No fake traffic-light dots.** Electron's `titleBarStyle: 'hiddenInset'`
 *   in `src/main/index.ts` renders the real macOS controls. The title bar
 *   here intentionally starts with the hive mark — adding fake dots would
 *   draw a second set under the real ones.
 * - **Streaming as a controlled animation.** A `useRef` tracks the cursor
 *   position into `AGENT_INCOMING` so React state churn doesn't reset it
 *   each tick; the interval only runs while the AGENT_FILE tab is active
 *   (matches the design-reference and keeps typing smooth elsewhere).
 * - **Routing via discriminated string keys** instead of a router lib —
 *   only three views, and `CommandPalette.nav` already speaks an opaque
 *   string target (`'prs'`, `'hub'`, `'terminal'`, `'proj:<id>'`). The
 *   palette and the activity rail funnel through the same `nav` function.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

import { Dock } from './components/AgentDock'
import { BottomPanel, type BottomPanelTab } from './components/BottomPanel'
import { CommandPalette } from './components/CommandPalette'
import { EditorGroup } from './components/Editor'
import { Explorer } from './components/Explorer'
import { PRsView } from './components/PRsView'
import { ProjectsHub, statusColor } from './components/ProjectsHub'
import { Icon, Pulse } from './components/primitives'
import {
  AGENT_FILE,
  AGENT_INCOMING,
  FILE_CONTENTS,
  board,
  chat,
  log,
  openTabs,
  problems,
  projects,
  prs,
  roster,
  tree,
  type Project,
} from './data/seed'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tab that is focused on first load. Matches the design-reference. */
const INITIAL_ACTIVE = 'src/components/AuthForm.tsx'

/** Length of the prefix of AGENT_INCOMING that is "already committed". */
const AGENT_BASE_LEN: number = FILE_CONTENTS[AGENT_FILE].length

/** ms between agent-streaming ticks. Matches the design-reference (~38 ms). */
const AGENT_TICK_MS = 38

/** Characters appended to the AGENT_FILE per tick. Matches the design-reference. */
const AGENT_TICK_CHARS = 2

/**
 * The three top-level views the workarea routes between. The activity rail
 * and command palette both feed into the same `setView` setter.
 */
type ViewKey = 'ide' | 'hub' | 'prs'

/** Activity-rail entry definitions. */
interface RailEntry {
  key: string
  icon: string
  label: string
  /** Optional view target — clicking the entry navigates here. */
  view?: ViewKey
  /** Optional badge number shown over the icon. */
  badge?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clone every entry from `FILE_CONTENTS` into a mutable record. */
function initContents(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(FILE_CONTENTS)) out[k] = FILE_CONTENTS[k]
  return out
}

/** Find the project currently flagged as `current`, or the first project. */
function defaultProject(): Project {
  return projects.find((p) => p.current) ?? projects[0]
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  // -------------------------------- routing
  const [view, setView] = useState<ViewKey>('ide')

  // -------------------------------- editor state
  const [contents, setContents] = useState<Record<string, string>>(initContents)
  const [saved, setSaved] = useState<Record<string, string>>(initContents)
  const [tabs, setTabs] = useState<string[]>(() => openTabs.slice())
  const [active, setActive] = useState<string | null>(INITIAL_ACTIVE)

  // -------------------------------- chrome state
  const [palette, setPalette] = useState(false)
  const [projMenu, setProjMenu] = useState(false)
  const [project, setProject] = useState<Project>(defaultProject)
  const [panelOpen, setPanelOpen] = useState(true)
  const [panelTab, setPanelTab] = useState<BottomPanelTab>('log')

  // -------------------------------- derived: dirty flags
  const dirty = useMemo<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {}
    for (const path of tabs) {
      // The AGENT_FILE is read-only while the agent is streaming into it,
      // so it never shows as dirty even though `contents[AGENT_FILE]` is
      // mutated each tick.
      if (path === AGENT_FILE) continue
      out[path] = contents[path] !== saved[path]
    }
    return out
  }, [tabs, contents, saved])

  // -------------------------------- editor callbacks
  const openFile = useCallback((path: string) => {
    setView('ide')
    setTabs((ts) => (ts.includes(path) ? ts : [...ts, path]))
    setActive(path)
    setContents((c) => (path in c ? c : { ...c, [path]: FILE_CONTENTS[path] ?? '' }))
    setSaved((s) => (path in s ? s : { ...s, [path]: FILE_CONTENTS[path] ?? '' }))
  }, [])

  const closeTab = useCallback(
    (path: string) => {
      setTabs((ts) => {
        const i = ts.indexOf(path)
        const next = ts.filter((p) => p !== path)
        if (active === path) {
          // Focus the neighbour to the left, falling back to the new first tab.
          setActive(next[Math.max(0, i - 1)] ?? next[0] ?? null)
        }
        return next
      })
    },
    [active],
  )

  const onChange = useCallback((path: string, value: string) => {
    setContents((c) => ({ ...c, [path]: value }))
  }, [])

  // -------------------------------- navigation
  const enterProject = useCallback((id: string) => {
    const p = projects.find((x) => x.id === id)
    if (p) setProject(p)
    setProjMenu(false)
    setView('ide')
  }, [])

  const nav = useCallback(
    (target: string) => {
      setPalette(false)
      if (target === 'prs') return setView('prs')
      if (target === 'hub') return setView('hub')
      if (target === 'terminal') {
        setPanelOpen(true)
        setPanelTab('terminal')
        return
      }
      if (target.startsWith('proj:')) return enterProject(target.slice(5))
      setView('ide')
    },
    [enterProject],
  )

  // -------------------------------- keyboard shortcuts (⌘K / ⌘S / ⌘J)
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return
      const k = event.key.toLowerCase()
      if (k === 'k') {
        event.preventDefault()
        setPalette((p) => !p)
        return
      }
      if (k === 's') {
        event.preventDefault()
        if (!active) return
        setSaved((s) => ({ ...s, [active]: contents[active] ?? '' }))
        return
      }
      if (k === 'j') {
        event.preventDefault()
        setPanelOpen((o) => !o)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, contents])

  // -------------------------------- live agent streaming
  // `posRef` survives re-renders so we don't restart the stream every tick.
  // The interval only runs while the IDE view is mounted AND the AGENT_FILE
  // is the active tab — matches the design-reference exactly.
  const posRef = useRef<number>(AGENT_BASE_LEN)
  useEffect(() => {
    if (view !== 'ide' || active !== AGENT_FILE) return
    if (posRef.current >= AGENT_INCOMING.length) return
    const id = window.setInterval(() => {
      posRef.current = Math.min(
        AGENT_INCOMING.length,
        posRef.current + AGENT_TICK_CHARS,
      )
      const next = AGENT_INCOMING.slice(0, posRef.current)
      setContents((c) => ({ ...c, [AGENT_FILE]: next }))
      if (posRef.current >= AGENT_INCOMING.length) window.clearInterval(id)
    }, AGENT_TICK_MS)
    return () => window.clearInterval(id)
  }, [view, active])

  // -------------------------------- activity rail
  const rail: ReadonlyArray<RailEntry> = useMemo(
    () => [
      { key: 'explorer', icon: 'files', label: 'Explorer', view: 'ide' },
      { key: 'hub', icon: 'layout-grid', label: 'Projects', view: 'hub' },
      {
        key: 'prs',
        icon: 'git-pull-request',
        label: 'Pull requests',
        view: 'prs',
        badge: prs.length,
      },
      { key: 'memory', icon: 'brain-circuit', label: 'Team memory' },
    ],
    [],
  )

  const railActive = useCallback(
    (k: string): boolean =>
      (k === 'explorer' && view === 'ide') || k === view,
    [view],
  )

  // -------------------------------- derived: live agent count
  const liveAgents = useMemo(
    () => roster.filter((a) => a.status === 'running').length,
    [],
  )

  // -------------------------------- render
  // The shell uses a fixed `data-accent="indigo"` — STORY-014 dropped the
  // tweaks panel that would otherwise expose accent switching.
  return (
    <div
      className="shell"
      data-accent="indigo"
      data-density="comfortable"
      data-platform={window.hive?.platform ?? 'darwin'}
    >
      {/* ----- title bar ----- */}
      <div className="titlebar">
        <div className="tb-brand">
          <img src="./hive-mark.png" alt="" />
          <span className="nm">
            Hive <span className="d">IDE</span>
          </span>
        </div>
        <div
          className="proj-switch"
          onClick={() => setProjMenu((m) => !m)}
          role="button"
          tabIndex={0}
        >
          <span
            className="proj-dot"
            style={{ background: statusColor(project.status) }}
          />
          <span className="pn">{project.name}</span>
          <span className="pb">{project.branch}</span>
          <Icon name="chevrons-up-down" size={14} />
        </div>
        <div className="tb-center">
          <div
            className="tb-search"
            onClick={() => setPalette(true)}
            role="button"
            tabIndex={0}
          >
            <Icon name="search" size={14} /> Search files, projects, agents…
            <span className="kbd">⌘K</span>
          </div>
        </div>
        <div className="tb-right">
          <button className="ib-btn" title="Notifications" type="button">
            <Icon name="bell" size={16} />
          </button>
          <button className="ib-btn" title="Settings" type="button">
            <Icon name="settings" size={16} />
          </button>
        </div>
      </div>

      {projMenu && (
        <ProjectMenu
          project={project}
          onPick={enterProject}
          onClose={() => setProjMenu(false)}
          onHub={() => {
            setProjMenu(false)
            setView('hub')
          }}
        />
      )}

      {/* ----- body: rail + workarea ----- */}
      <div className="body">
        <nav className="rail">
          <div className="brand">
            <img src="./hive-mark.png" alt="Hive" />
          </div>
          {rail.map((r) => (
            <button
              key={r.key}
              className={'rail-btn' + (railActive(r.key) ? ' active' : '')}
              title={r.label}
              type="button"
              onClick={() => r.view && nav(r.view)}
            >
              <Icon name={r.icon} size={21} />
              {r.badge !== undefined && r.badge > 0 && (
                <span className="rail-badge">{r.badge}</span>
              )}
            </button>
          ))}
          <div className="rail-spacer" />
          <button className="rail-btn" title="Docs" type="button">
            <Icon name="book-open" size={21} />
          </button>
          <div className="rail-ava" title="You">
            JD
          </div>
        </nav>

        <div className="workarea">
          {view === 'hub' && (
            <ProjectsHub
              onEnter={enterProject}
              currentId={project.id}
              projects={projects}
            />
          )}
          {view === 'prs' && <PRsView onOpenFile={openFile} prs={prs} />}
          {view === 'ide' && (
            <div
              className="ide"
              data-dock="shown"
              data-panel={panelOpen ? 'open' : 'closed'}
              style={
                {
                  '--panel-h': panelOpen ? '232px' : '0px',
                } as CSSProperties & Record<`--${string}`, string>
              }
            >
              {/*
                Explorer is now fully store-driven (STORY-025). It reads
                project + repos + expandedSet + selectedExplorerPath +
                childrenCache from the workspace store and writes back via
                store actions. The legacy seed-data props (openFile,
                activePath, project, tree) are intentionally gone — that
                wiring moves over to the store in STORY-028 (App rewire).
              */}
              <Explorer />
              <EditorGroup
                tabs={tabs}
                active={active}
                dirty={dirty}
                contents={contents}
                agentFile={AGENT_FILE}
                agentBaseLen={AGENT_BASE_LEN}
                onSelect={setActive}
                onClose={closeTab}
                onChange={onChange}
              />
              <Dock
                onOpenFile={openFile}
                board={board}
                roster={roster}
                chat={chat}
              />
              {panelOpen && (
                <BottomPanel
                  tab={panelTab}
                  setTab={setPanelTab}
                  onClose={() => setPanelOpen(false)}
                  onOpenFile={openFile}
                  log={log}
                  problems={problems}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* ----- status bar (indigo) ----- */}
      <div className="statusbar">
        <span
          className="sb-i sb-btn"
          onClick={() => setProjMenu(true)}
          role="button"
          tabIndex={0}
        >
          <Icon name="git-branch" size={13} /> {project.branch}
        </span>
        <span className="sb-live">
          <Pulse /> {liveAgents} agents live
        </span>
        <span className="sb-i">
          <Icon name="box" size={13} /> {project.runs} run
          {project.runs !== 1 ? 's' : ''}
        </span>
        <span
          className="sb-i sb-btn"
          onClick={() => {
            setPanelOpen(true)
            setPanelTab('problems')
          }}
          role="button"
          tabIndex={0}
        >
          <Icon name="alert-triangle" size={13} /> {problems.length}
        </span>
        <div className="right">
          <span className="sb-i">
            <Icon name="timer" size={13} /> next tick 00:38
          </span>
          <span
            className="sb-i sb-btn"
            onClick={() => {
              setPanelOpen(true)
              setPanelTab('terminal')
            }}
            role="button"
            tabIndex={0}
          >
            <Icon name="square-terminal" size={13} /> Terminal
          </span>
          <span className="sb-i">
            <Icon name="brain-circuit" size={13} /> mempalace · synced
          </span>
          <span className="sb-i">Opus 4.7</span>
        </div>
      </div>

      {palette && (
        <CommandPalette
          onClose={() => setPalette(false)}
          onNav={nav}
          onOpenFile={openFile}
          projects={projects}
          tree={tree}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectMenu — dropdown shown when the title-bar project switcher or the
// status-bar branch chip is clicked. Lists every project with a status dot,
// stack + branch, and agent count (or 'idle' when the project has no agents).
// ---------------------------------------------------------------------------

interface ProjectMenuProps {
  project: Project
  onPick: (id: string) => void
  onClose: () => void
  onHub: () => void
}

function ProjectMenu({ project, onPick, onClose, onHub }: ProjectMenuProps) {
  return (
    <>
      <div
        // Invisible scrim that closes the menu on any outside click.
        style={{ position: 'fixed', inset: 0, zIndex: 80 }}
        onClick={onClose}
      />
      <div className="menu">
        <div className="menu-head">Switch project</div>
        {projects.map((p) => (
          <div
            key={p.id}
            className={'menu-item' + (p.id === project.id ? ' cur' : '')}
            onClick={() => onPick(p.id)}
          >
            <span
              className="proj-dot"
              style={{
                background: statusColor(p.status),
                width: 8,
                height: 8,
              }}
            />
            <div className="mi-meta">
              <div className="mi-n">{p.name}</div>
              <div className="mi-s">
                {p.stack} · {p.branch}
              </div>
            </div>
            {p.agents > 0 ? (
              <span
                style={{
                  font: 'var(--t-meta)',
                  color: 'var(--fg-2)',
                  display: 'inline-flex',
                  gap: 5,
                  alignItems: 'center',
                }}
              >
                {p.status === 'running' && <Pulse />}
                {p.agents}
              </span>
            ) : (
              <span style={{ font: 'var(--t-meta)', color: 'var(--fg-3)' }}>
                idle
              </span>
            )}
          </div>
        ))}
        <div className="menu-foot">
          <button
            className="ib-btn"
            type="button"
            onClick={onHub}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 10px',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-sm)',
              background: 'transparent',
              color: 'var(--fg-1)',
              font: 'var(--t-body-sm)',
              cursor: 'pointer',
            }}
          >
            <Icon name="layout-grid" size={14} /> Open Projects hub
          </button>
        </div>
      </div>
    </>
  )
}
