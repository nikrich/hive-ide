/**
 * Welcome / Projects hub view (REQ-003 explicit-project model).
 *
 * A project is now a user-named container of repos — not a folder. The
 * Welcome screen surfaces:
 *
 * - A prominent "+ New Project" CTA that opens the {@link NewProjectModal}.
 * - The recents grid (or an empty-state hint when there are none).
 * - Stats summarising what the user has created so far.
 *
 * Routing — when does Welcome mount vs the IDE — is owned by App.tsx.
 * This component is fine to mount unconditionally; it derives everything
 * from the store.
 */

import { useCallback, useEffect, useState } from 'react'

import { formatRelativeTime } from '../lib/relativeTime'
import type { RecentEntry } from '../../../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import NewProjectModal from './NewProjectModal'
import { Btn, Icon } from './primitives'

// ---------------------------------------------------------------------------
// Legacy status-color helper — retained for the title-bar chip in App.tsx.
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
// ProjectsHub
// ---------------------------------------------------------------------------

export interface ProjectsHubProps {
  /**
   * Called when the operator clicks a recent card. The id is the
   * stable `Project.id` generated at creation time.
   */
  onEnter?: (id: string) => void
}

export function ProjectsHub({ onEnter }: ProjectsHubProps) {
  const recents = useWorkspaceStore((s) => s.recents)
  const currentId = useWorkspaceStore((s) => s.project?.id ?? null)
  const [showNewProject, setShowNewProject] = useState(false)

  const openNewProject = useCallback(() => setShowNewProject(true), [])
  const closeNewProject = useCallback(() => setShowNewProject(false), [])

  // ⌘⇧N opens the New Project modal while the hub is mounted. App.tsx
  // also binds this shortcut globally, but a local binding lets ⌘⇧N work
  // before the IDE shell has wired its global handlers.
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

  // ----- derived stats --------------------------------------------------
  const totalRepos = recents.reduce((sum, r) => sum + r.repoCount, 0)
  const emptyProjects = recents.filter((r) => r.repoCount === 0).length
  const multiRepoProjects = recents.filter((r) => r.repoCount > 1).length

  return (
    <div className="view">
      <div className="phead">
        <div className="phead-row">
          <div>
            <div className="eyebrow">Workspace</div>
            <h1>Welcome</h1>
            <div className="sub">
              A project is a group of folders you work on together. Create one
              and add the repos that belong inside it.
            </div>
          </div>
          <Btn kind="amber" icon="plus" onClick={openNewProject}>
            New Project
            <span className="kbd kbd-on-btn">⌘⇧N</span>
          </Btn>
        </div>
      </div>

      <div className="stats">
        <div className="card stat">
          <div className="n">{recents.length}</div>
          <div className="l">Projects</div>
        </div>
        <div className="card stat">
          <div className="n">{totalRepos}</div>
          <div className="l">Repos tracked</div>
        </div>
        <div className="card stat">
          <div className="n">{multiRepoProjects}</div>
          <div className="l">Multi-repo</div>
        </div>
        <div className="card stat">
          <div className="n">{emptyProjects}</div>
          <div className="l">Empty (no repos)</div>
        </div>
      </div>

      {recents.length === 0 ? (
        <div className="hub-empty">
          <p>No projects yet.</p>
          <Btn kind="amber" icon="plus" onClick={openNewProject}>
            Create your first project
          </Btn>
        </div>
      ) : (
        <div className="hub-grid">
          {recents.map((r) => (
            <RecentCard
              key={r.id}
              recent={r}
              isCurrent={currentId === r.id}
              onEnter={onEnter}
            />
          ))}
        </div>
      )}

      {showNewProject && <NewProjectModal onClose={closeNewProject} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RecentCard
// ---------------------------------------------------------------------------

interface RecentCardProps {
  recent: RecentEntry
  isCurrent: boolean
  onEnter?: (id: string) => void
}

function RecentCard({ recent, isCurrent, onEnter }: RecentCardProps) {
  const handleClick = useCallback(() => {
    onEnter?.(recent.id)
  }, [onEnter, recent.id])

  const repoLabel =
    recent.repoCount === 0
      ? 'No repos'
      : recent.repoCount === 1
        ? '1 repo'
        : `${recent.repoCount} repos`

  return (
    <div
      className="card click pcard"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
    >
      <div className="pcard-top">
        <div className="pcard-id">
          <div className="pn">{recent.name}</div>
        </div>
      </div>

      <div className="pcard-foot">
        <span className="brn">
          <Icon name="folder-git-2" size={13} /> {repoLabel}
        </span>
        <span className="pcard-when">
          {formatRelativeTime(recent.lastOpenedAt)}
        </span>
      </div>

      {isCurrent && <div className="pcard-current">● currently open</div>}
    </div>
  )
}

export default ProjectsHub
