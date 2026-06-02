/**
 * Welcome / Projects hub view.
 *
 * STORY-027 repurposes the original `ProjectsHub` design as the Welcome
 * screen. The visual shell — header, four-card stats row, responsive
 * card grid — survives, but the data is real now: recents come from the
 * Zustand workspace store, not the seeded `acme/*` cards.
 *
 * Responsibilities owned by this component
 * ----------------------------------------
 * - Render the recents grid (or an empty-state hint when there are none).
 * - Surface project metadata: name, source-chip, repo count, rootPath,
 *   relative last-opened time.
 * - Mark the project currently mounted in the editor with the
 *   "● currently open" accent line.
 * - Provide a prominent "Open Folder…" button (⌘O hint + keyboard shortcut)
 *   that drives the shared `openFolderFlow` helper.
 *
 * Routing — when does Welcome mount vs. the IDE — is owned by App.tsx
 * (STORY-028). This component is fine to mount unconditionally; it derives
 * everything it needs from the store and `window.hive`.
 */

import { useCallback, useEffect } from 'react'

import { openFolderFlow } from '../lib/openFolder'
import { formatRelativeTime } from '../lib/relativeTime'
import type { ProjectSource, RecentEntry } from '../../../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import { Btn, Icon } from './primitives'

// ---------------------------------------------------------------------------
// Legacy status-color helper
// ---------------------------------------------------------------------------

/**
 * Map a project/story status string to the CSS-var colour used for the dot
 * inside a project card. Falls back to `--fg-3` for unknown values so the
 * UI degrades gracefully rather than rendering an empty dot.
 *
 * Retained for the title-bar project switcher and status-bar branch chip
 * — both still drive off the seed `ProjectStatus` union. Once STORY-028
 * fully migrates the shell to the workspace store, this can move to
 * `primitives/` or be retired entirely.
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

// ---------------------------------------------------------------------------
// Source-chip metadata
// ---------------------------------------------------------------------------

interface SourceChipMeta {
  label: string
  /** CSS class applied to the chip — drives colour via `ide.css`. */
  cls: string
}

/**
 * Human-readable label + colour treatment for each {@link ProjectSource}.
 * The label is the detection rule that fired, so the operator can see
 * *why* repos were grouped the way they were.
 */
const SOURCE_META: Record<ProjectSource, SourceChipMeta> = {
  hive: { label: 'hive', cls: 'src-hive' },
  'auto-detected': { label: 'auto-detected', cls: 'src-auto' },
  'single-repo': { label: 'single-repo', cls: 'src-single' },
  empty: { label: 'empty', cls: 'src-empty' },
}

interface SourceChipProps {
  source: ProjectSource
}

function SourceChip({ source }: SourceChipProps) {
  const meta = SOURCE_META[source]
  return (
    <span className={`source-chip ${meta.cls}`}>
      <span className="dot" />
      {meta.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// ProjectsHub
// ---------------------------------------------------------------------------

export interface ProjectsHubProps {
  /**
   * Called when the operator clicks a recent card. The id matches
   * `RecentEntry.id` (= `sha1(rootPath)`).
   *
   * Optional because STORY-028 (App.tsx routing) is the consumer that
   * decides what "entering" means — most callers will hook this up to
   * `setProject` via re-detection. While that integration lands, the hub
   * still functions: the Open Folder button is the primary CTA.
   */
  onEnter?: (id: string) => void
}

export function ProjectsHub({ onEnter }: ProjectsHubProps) {
  // Pull recents + currently-open id from the store. Selectors are
  // narrow so unrelated state churn (open tabs, dirty map…) doesn't
  // re-render the hub.
  const recents = useWorkspaceStore((s) => s.recents)
  const currentId = useWorkspaceStore((s) => s.project?.id ?? null)

  const handleOpenFolder = useCallback(async () => {
    // Swallow errors at the boundary — the dialog and detect handlers
    // both reject loudly via IPC; surfacing a toast/error UI is a future
    // story. Logging keeps the failure observable in DevTools.
    try {
      await openFolderFlow()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Open Folder flow failed:', err)
    }
  }, [])

  // ⌘O / Ctrl+O shortcut while the hub is mounted. Scoped to the
  // component rather than installed globally in App.tsx so it disappears
  // automatically when the user is inside the editor view.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return
      if (event.key.toLowerCase() !== 'o') return
      event.preventDefault()
      void handleOpenFolder()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleOpenFolder])

  // ----- derived stats --------------------------------------------------
  // The original four-card row was tied to the seed `Project` shape
  // (agents, runs, blocked). With recents-only data we surface what we
  // actually know: total recents, repo count across them, unique sources.
  const totalRepos = recents.reduce((sum, r) => sum + r.repoCount, 0)
  const hiveProjects = recents.filter((r) => r.source === 'hive').length
  const autoProjects = recents.filter((r) => r.source === 'auto-detected').length

  return (
    <div className="view">
      <div className="phead">
        <div className="phead-row">
          <div>
            <div className="eyebrow">Workspace</div>
            <h1>Welcome</h1>
            <div className="sub">
              Open any folder — Hive auto-detects the repos inside and remembers
              what you opened last.
            </div>
          </div>
          <Btn kind="primary" icon="folder-plus" onClick={handleOpenFolder}>
            Open Folder…
            <span className="kbd kbd-on-btn">⌘O</span>
          </Btn>
        </div>
      </div>

      <div className="stats">
        <div className="card stat">
          <div className="n">{recents.length}</div>
          <div className="l">Recent projects</div>
        </div>
        <div className="card stat">
          <div className="n">{totalRepos}</div>
          <div className="l">Repos tracked</div>
        </div>
        <div className="card stat">
          <div className="n">{hiveProjects}</div>
          <div className="l">Hive workspaces</div>
        </div>
        <div className="card stat">
          <div className="n">{autoProjects}</div>
          <div className="l">Auto-detected</div>
        </div>
      </div>

      {recents.length === 0 ? (
        <div className="hub-empty">Open any folder — repos auto-detected</div>
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
    recent.repoCount === 1 ? '1 repo' : `${recent.repoCount} repos`

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
          <div className="pcard-path" title={recent.rootPath}>
            {recent.rootPath}
          </div>
        </div>
        <SourceChip source={recent.source} />
      </div>

      <div className="pcard-foot">
        <span className="brn">
          <Icon name="folder-git-2" size={13} /> {repoLabel}
        </span>
        <span className="pcard-when">
          {formatRelativeTime(recent.lastOpenedAt)}
        </span>
      </div>

      {isCurrent && (
        <div className="pcard-current">● currently open</div>
      )}
    </div>
  )
}
