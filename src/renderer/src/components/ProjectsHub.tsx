/**
 * Projects view — dense, IDE-native (design rework).
 *
 * The previous "Welcome" treatment (hero heading + stat cards + card grid)
 * read as a marketing page, not tooling — exactly what the user rejected in
 * the design chat ("it looks like a website"). This is the rebuilt surface:
 *
 *   ┌ Projects ──────────────────────────────────────────────────────┐
 *   │ [All] [Multi-repo] [Empty]     🔍 Filter…       [+ New Project] │  ← toolbar
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ PROJECT          REPOS   LAST OPENED                   ●         │  ← sticky head
 *   │ acme-web           3     2m ago                     open  ›      │
 *   │ payments-api       1     26m ago                          ›      │  ← dense rows
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Crucially this is driven by the REAL `recents` store — there are no
 * invented status / agent / requirement columns. The design prototype used
 * mock orchestration data; this codebase has deliberately de-mocked the
 * project model (see App.tsx: "no fake acme/* rows"), so the table surfaces
 * only what's real: name, repo count, last-opened, and the open marker.
 *
 * Routing — when Welcome vs the IDE mounts — is owned by App.tsx. This
 * component derives everything from the store and is safe to mount whenever.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formatRelativeTime } from '../lib/relativeTime'
import type { RecentEntry } from '../../../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import NewProjectModal from './NewProjectModal'
import { Btn, Icon, InlineEditable, ContextMenu, type InlineEditableHandle } from './primitives'

// ---------------------------------------------------------------------------
// Legacy status-color helper — retained for callers that still map a Hive
// run status to a CSS var. Unused by this view (real projects have no run
// status) but cheap to keep exported.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Filter segments — derived from the real data model, not mock statuses.
// ---------------------------------------------------------------------------

type FilterKey = 'all' | 'multi' | 'empty'

interface SegDef {
  k: FilterKey
  label: string
}

const SEGS: ReadonlyArray<SegDef> = [
  { k: 'all', label: 'All' },
  { k: 'multi', label: 'Multi-repo' },
  { k: 'empty', label: 'Empty' },
]

function matchesFilter(r: RecentEntry, filter: FilterKey): boolean {
  if (filter === 'multi') return r.repoCount > 1
  if (filter === 'empty') return r.repoCount === 0
  return true
}

// ---------------------------------------------------------------------------
// ProjectsHub
// ---------------------------------------------------------------------------

export interface ProjectsHubProps {
  /**
   * Called when the operator activates a row. The id is the stable
   * `Project.id` generated at creation time.
   */
  onEnter?: (id: string) => void
}

export function ProjectsHub({ onEnter }: ProjectsHubProps) {
  const recents = useWorkspaceStore((s) => s.recents)
  const currentId = useWorkspaceStore((s) => s.project?.id ?? null)
  const [showNewProject, setShowNewProject] = useState(false)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [q, setQ] = useState('')

  const openNewProject = useCallback(() => setShowNewProject(true), [])
  const closeNewProject = useCallback(() => setShowNewProject(false), [])

  // ⌘⇧N opens the New Project modal while the hub is mounted. App.tsx also
  // binds this globally; a local binding lets ⌘⇧N work before the IDE shell
  // has wired its global handlers.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || !event.shiftKey) return
      if (event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      openNewProject()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openNewProject])

  // ----- segment counts (over the unfiltered set) -----------------------
  const counts = useMemo<Record<FilterKey, number>>(
    () => ({
      all: recents.length,
      multi: recents.filter((r) => r.repoCount > 1).length,
      empty: recents.filter((r) => r.repoCount === 0).length,
    }),
    [recents],
  )

  // ----- visible rows ---------------------------------------------------
  const query = q.trim().toLowerCase()
  const rows = useMemo(
    () =>
      recents.filter(
        (r) =>
          matchesFilter(r, filter) &&
          (query === '' || r.name.toLowerCase().includes(query)),
      ),
    [recents, filter, query],
  )

  return (
    <div className="wsview">
      <div className="ws-tabbar">
        <div className="ws-tab">
          <Icon name="layout-grid" size={14} /> Projects
        </div>
      </div>

      <div className="ws-toolbar">
        <div className="seg">
          {SEGS.map((s) => (
            <button
              key={s.k}
              className={filter === s.k ? 'on' : ''}
              onClick={() => setFilter(s.k)}
              type="button"
            >
              {s.label} <span className="sc">{counts[s.k]}</span>
            </button>
          ))}
        </div>
        <div className="ws-tb-right">
          <div className="ws-find">
            <Icon name="search" size={14} />
            <input
              value={q}
              placeholder="Filter projects…"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Btn kind="amber" sm icon="plus" onClick={openNewProject}>
            New Project
            <span className="kbd kbd-on-btn">⌘⇧N</span>
          </Btn>
        </div>
      </div>

      <div className="ws-scroll">
        <div className="ptable ptable-recents">
          <div className="prow ptable-head ptable-cols">
            <span className="th">Project</span>
            <span className="th">Repos</span>
            <span className="th">Last opened</span>
            <span className="th r">Status</span>
            <span className="th" />
          </div>
          {rows.map((r) => (
            <ProjectRow
              key={r.id}
              recent={r}
              isCurrent={currentId === r.id}
              onEnter={onEnter}
            />
          ))}
          {rows.length === 0 && (
            <div className="ws-empty">
              {recents.length === 0 ? (
                <>
                  No projects yet.{' '}
                  <button
                    type="button"
                    className="ws-empty-link"
                    onClick={openNewProject}
                  >
                    Create your first project
                  </button>
                  .
                </>
              ) : (
                'No projects match this filter.'
              )}
            </div>
          )}
        </div>
      </div>

      {showNewProject && <NewProjectModal onClose={closeNewProject} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectRow — one dense table row.
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  recent: RecentEntry
  isCurrent: boolean
  onEnter?: (id: string) => void
}

function ProjectRow({ recent, isCurrent, onEnter }: ProjectRowProps) {
  const renameProject = useWorkspaceStore((s) => s.renameProject)
  const editRef = useRef<InlineEditableHandle | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const enter = useCallback(() => onEnter?.(recent.id), [onEnter, recent.id])

  const repoLabel =
    recent.repoCount === 0
      ? 'No repos'
      : recent.repoCount === 1
        ? '1 repo'
        : `${recent.repoCount} repos`

  return (
    <div
      className={'prow data ptable-cols' + (isCurrent ? ' cur' : '')}
      onClick={enter}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          enter()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      title={`Open ${recent.name}`}
    >
      <div
        className="pc-name"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="nm">
          <InlineEditable
            ref={editRef}
            value={recent.name}
            ariaLabel="Rename project"
            onCommit={(next) => renameProject(recent.id, next)}
          />
        </div>
        <div className="sk">{repoLabel}</div>
      </div>
      <span className="pc-repos">
        <Icon name="folder-git-2" size={13} /> {recent.repoCount}
      </span>
      <span className="pc-act">{formatRelativeTime(recent.lastOpenedAt)}</span>
      <span className="pc-open">
        {isCurrent ? <span className="live">● open</span> : '—'}
      </span>
      <span className="pc-chev">
        <Icon name="chevron-right" size={16} />
      </span>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: 'Rename', onSelect: () => editRef.current?.startEditing() },
            { label: 'Open', onSelect: enter },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

export default ProjectsHub
