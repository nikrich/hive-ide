/**
 * Source Control view — REQ-008.
 *
 * VSCode-equivalent SCM panel. For every git-enabled repo in the active
 * project we render three sections (Merge Conflicts, Staged Changes,
 * Changes). Each file row has inline stage/unstage/discard controls and
 * opens a Monaco DiffEditor on click via {@link useWorkspaceStore.openDiffTab}.
 *
 * v1 scope (see REQ-008):
 *
 *   - File-level staging (no per-hunk)
 *   - Commit textarea with ⌘⏎ shortcut
 *   - Push / pull buttons with ahead/behind counts in the repo header
 *   - Manual refresh + automatic refresh on fs-change (500 ms debounce)
 *   - No branch switcher here — that lives in the status bar (REQ-008)
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

import { Icon } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'
import { formatRelativeTime } from '../lib/relativeTime'
import type {
  GitLogEntry,
  GitStashEntry,
  GitStatusEntry,
  Repo,
} from '../../../types/workspace'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RepoBucket {
  conflicts: GitStatusEntry[]
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
}

/** Group a repo's status entries into the three SCM sections. */
function bucketize(entries: readonly GitStatusEntry[]): RepoBucket {
  const conflicts: GitStatusEntry[] = []
  const staged: GitStatusEntry[] = []
  const unstaged: GitStatusEntry[] = []
  for (const e of entries) {
    if (e.state === 'conflicted') {
      conflicts.push(e)
      continue
    }
    if (e.staged) staged.push(e)
    if (e.workingTree) unstaged.push(e)
  }
  return { conflicts, staged, unstaged }
}

/** One-letter status badge for a status entry. */
function badgeFor(entry: GitStatusEntry): { letter: string; cls: string } {
  switch (entry.state) {
    case 'modified':
      return { letter: 'M', cls: 'git-M' }
    case 'added':
      return { letter: 'A', cls: 'git-A' }
    case 'deleted':
      return { letter: 'D', cls: 'scm-D' }
    case 'renamed':
      return { letter: 'R', cls: 'scm-R' }
    case 'untracked':
      return { letter: 'U', cls: 'git-U' }
    case 'conflicted':
      return { letter: '!', cls: 'scm-C' }
  }
}

// ---------------------------------------------------------------------------
// Section + Row
// ---------------------------------------------------------------------------

interface RowProps {
  entry: GitStatusEntry
  repo: Repo
  section: 'staged' | 'unstaged' | 'conflicts'
  onOpenDiff: (entry: GitStatusEntry, repo: Repo, section: 'staged' | 'unstaged') => void
  onStage: (repo: Repo, path: string) => void
  onUnstage: (repo: Repo, path: string) => void
  onDiscard: (repo: Repo, path: string) => void
}

function Row({
  entry,
  repo,
  section,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: RowProps) {
  const badge = badgeFor(entry)
  return (
    <div
      className="scm-row"
      onClick={() =>
        section !== 'conflicts' && onOpenDiff(entry, repo, section)
      }
      role="button"
      tabIndex={0}
      title={entry.path}
    >
      <span className={'scm-badge ' + badge.cls}>{badge.letter}</span>
      <span className="scm-path">{entry.path}</span>
      <span className="scm-actions">
        {section === 'unstaged' && (
          <button
            type="button"
            className="ib-btn scm-ib"
            title="Discard changes"
            onClick={(e) => {
              e.stopPropagation()
              onDiscard(repo, entry.path)
            }}
          >
            <Icon name="undo-2" size={14} />
          </button>
        )}
        {section === 'unstaged' && (
          <button
            type="button"
            className="ib-btn scm-ib"
            title="Stage"
            onClick={(e) => {
              e.stopPropagation()
              onStage(repo, entry.path)
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        )}
        {section === 'staged' && (
          <button
            type="button"
            className="ib-btn scm-ib"
            title="Unstage"
            onClick={(e) => {
              e.stopPropagation()
              onUnstage(repo, entry.path)
            }}
          >
            <Icon name="minus" size={14} />
          </button>
        )}
      </span>
    </div>
  )
}

interface SectionProps {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  /** Action button rendered on the right (e.g. "Stage All"). */
  actions?: React.ReactNode
  children: React.ReactNode
}

function Section({ title, count, collapsed, onToggle, actions, children }: SectionProps) {
  return (
    <div className="scm-section">
      <div
        className="scm-section-head"
        onClick={onToggle}
        role="button"
        tabIndex={0}
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
        <span className="scm-section-title">{title}</span>
        <span className="scm-section-count">{count}</span>
        {actions && <span className="scm-section-actions">{actions}</span>}
      </div>
      {!collapsed && children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-repo block
// ---------------------------------------------------------------------------

interface RepoBlockProps {
  repo: Repo
  scm: ReturnType<typeof useWorkspaceStore.getState>['scm'][string]
  busyRepos: Set<string>
  setBusy: (repoPath: string, busy: boolean) => void
  showError: (msg: string) => void
}

function RepoBlock({ repo, scm, busyRepos, setBusy, showError }: RepoBlockProps) {
  const fetchScm = useWorkspaceStore((s) => s.fetchScm)
  const openDiffTab = useWorkspaceStore((s) => s.openDiffTab)
  const setMergeTarget = useWorkspaceStore((s) => s.setMergeTarget)

  const [collapsed, setCollapsed] = useState<{ [k: string]: boolean }>({})
  const [commitMessage, setCommitMessage] = useState('')

  const buckets = useMemo<RepoBucket>(
    () => bucketize(scm?.entries ?? []),
    [scm?.entries],
  )

  const handleStage = useCallback(
    async (r: Repo, path: string) => {
      try {
        setBusy(r.path, true)
        await window.hive.git.stage(r.path, [path])
        await fetchScm(r.path)
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(r.path, false)
      }
    },
    [fetchScm, setBusy, showError],
  )

  const handleUnstage = useCallback(
    async (r: Repo, path: string) => {
      try {
        setBusy(r.path, true)
        await window.hive.git.unstage(r.path, [path])
        await fetchScm(r.path)
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(r.path, false)
      }
    },
    [fetchScm, setBusy, showError],
  )

  const handleDiscard = useCallback(
    async (r: Repo, path: string) => {
      const ok = window.confirm(
        `Discard changes to "${path}"?\n\nThis cannot be undone.`,
      )
      if (!ok) return
      try {
        setBusy(r.path, true)
        await window.hive.git.discard(r.path, [path])
        await fetchScm(r.path)
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(r.path, false)
      }
    },
    [fetchScm, setBusy, showError],
  )

  const handleStageAll = useCallback(async () => {
    const paths = buckets.unstaged.map((e) => e.path)
    if (paths.length === 0) return
    try {
      setBusy(repo.path, true)
      await window.hive.git.stage(repo.path, paths)
      await fetchScm(repo.path)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(repo.path, false)
    }
  }, [buckets.unstaged, repo.path, fetchScm, setBusy, showError])

  const handleUnstageAll = useCallback(async () => {
    const paths = buckets.staged.map((e) => e.path)
    if (paths.length === 0) return
    try {
      setBusy(repo.path, true)
      await window.hive.git.unstage(repo.path, paths)
      await fetchScm(repo.path)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(repo.path, false)
    }
  }, [buckets.staged, repo.path, fetchScm, setBusy, showError])

  const handleCommit = useCallback(async () => {
    const msg = commitMessage.trim()
    if (msg.length === 0 || buckets.staged.length === 0) return
    try {
      setBusy(repo.path, true)
      await window.hive.git.commit(repo.path, msg)
      setCommitMessage('')
      await fetchScm(repo.path)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(repo.path, false)
    }
  }, [commitMessage, buckets.staged.length, repo.path, fetchScm, setBusy, showError])

  const handlePush = useCallback(async () => {
    try {
      setBusy(repo.path, true)
      await window.hive.git.push(repo.path)
      await fetchScm(repo.path)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(repo.path, false)
    }
  }, [repo.path, fetchScm, setBusy, showError])

  const handlePull = useCallback(async () => {
    try {
      setBusy(repo.path, true)
      await window.hive.git.pull(repo.path)
      await fetchScm(repo.path)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(repo.path, false)
    }
  }, [repo.path, fetchScm, setBusy, showError])

  // ----- E7-09 stash + E7-07 history + E7-10 amend ----------------------
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [amend, setAmend] = useState(false)

  const refreshAux = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        window.hive.git.stashList(repo.path),
        window.hive.git.log(repo.path, 30),
      ])
      setStashes(s)
      setCommits(c)
    } catch {
      // Aux panels are best-effort; the main status view is the source of truth.
    }
  }, [repo.path])

  useEffect(() => {
    void refreshAux()
  }, [refreshAux, scm])

  const handleAmend = useCallback(async () => {
    const msg = commitMessage.trim()
    if (msg.length === 0) return
    try {
      setBusy(repo.path, true)
      await window.hive.git.commitAmend(repo.path, msg)
      setCommitMessage('')
      setAmend(false)
      await fetchScm(repo.path)
      await refreshAux()
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(repo.path, false)
    }
  }, [commitMessage, repo.path, fetchScm, refreshAux, setBusy, showError])

  // Recall the last commit message when amend is toggled on (E7-10).
  const toggleAmend = useCallback(() => {
    setAmend((on) => {
      const next = !on
      if (next && commitMessage.trim() === '' && commits[0]) {
        setCommitMessage(commits[0].subject)
      }
      return next
    })
  }, [commitMessage, commits])

  const handleStashPush = useCallback(async () => {
    try {
      setBusy(repo.path, true)
      await window.hive.git.stashPush(repo.path)
      await fetchScm(repo.path)
      await refreshAux()
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(repo.path, false)
    }
  }, [repo.path, fetchScm, refreshAux, setBusy, showError])

  const stashOp = useCallback(
    async (op: 'apply' | 'pop' | 'drop', ref: string) => {
      try {
        setBusy(repo.path, true)
        if (op === 'apply') await window.hive.git.stashApply(repo.path, ref)
        else if (op === 'pop') await window.hive.git.stashPop(repo.path, ref)
        else await window.hive.git.stashDrop(repo.path, ref)
        await fetchScm(repo.path)
        await refreshAux()
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(repo.path, false)
      }
    },
    [repo.path, fetchScm, refreshAux, setBusy, showError],
  )

  const handleDiscardAll = useCallback(async () => {
    const paths = buckets.unstaged
      .filter((e) => e.state !== 'untracked')
      .map((e) => e.path)
    const untracked = buckets.unstaged
      .filter((e) => e.state === 'untracked')
      .map((e) => e.path)
    const all = [...paths, ...untracked]
    if (all.length === 0) return
    if (
      !window.confirm(
        `Discard changes in ${all.length} file${all.length === 1 ? '' : 's'}? This cannot be undone.`,
      )
    ) {
      return
    }
    try {
      setBusy(repo.path, true)
      await window.hive.git.discard(repo.path, all)
      await fetchScm(repo.path)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(repo.path, false)
    }
  }, [buckets.unstaged, repo.path, fetchScm, setBusy, showError])

  const onCommitKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void (amend ? handleAmend() : handleCommit())
    }
  }

  const toggle = (k: string) =>
    setCollapsed((prev) => ({ ...prev, [k]: !prev[k] }))

  const isBusy = busyRepos.has(repo.path)
  const commitDisabled =
    isBusy || commitMessage.trim().length === 0 || buckets.staged.length === 0

  const onOpenDiff = useCallback(
    (entry: GitStatusEntry, r: Repo, section: 'staged' | 'unstaged') => {
      const ref: 'index' | 'head' = section === 'staged' ? 'index' : 'head'
      const tail = section === 'staged' ? '(Index)' : '(Working Tree)'
      openDiffTab({
        repoPath: r.path,
        path: entry.path,
        ref,
        label: `${entry.path.split('/').pop() ?? entry.path} ${tail}`,
      })
    },
    [openDiffTab],
  )

  return (
    <div className="scm-repo">
      <div className="scm-repo-head">
        <Icon name="git-branch" size={14} />
        <span className="scm-repo-name">{repo.name}</span>
        {scm?.branch && (
          <span className="scm-branch-chip">{scm.branch}</span>
        )}
        {scm && (scm.ahead > 0 || scm.behind > 0) && (
          <span className="scm-ab" title={`${scm.ahead} ahead, ${scm.behind} behind`}>
            {scm.ahead > 0 && (
              <>
                <Icon name="arrow-up" size={11} />
                {scm.ahead}
              </>
            )}
            {scm.behind > 0 && (
              <>
                <Icon name="arrow-down" size={11} />
                {scm.behind}
              </>
            )}
          </span>
        )}
        <div className="scm-repo-actions">
          <button
            type="button"
            className="ib-btn"
            title="Pull"
            disabled={isBusy}
            onClick={() => void handlePull()}
          >
            <Icon name="arrow-down-to-line" size={14} />
          </button>
          <button
            type="button"
            className="ib-btn"
            title="Push"
            disabled={isBusy}
            onClick={() => void handlePush()}
          >
            <Icon name="arrow-up-from-line" size={14} />
          </button>
          <button
            type="button"
            className="ib-btn"
            title="Stash changes"
            disabled={isBusy}
            onClick={() => void handleStashPush()}
          >
            <Icon name="archive" size={14} />
          </button>
          <button
            type="button"
            className="ib-btn"
            title="Refresh"
            disabled={isBusy}
            onClick={() => void fetchScm(repo.path)}
          >
            <Icon name="refresh-cw" size={14} />
          </button>
        </div>
      </div>

      <div className="scm-commit">
        <textarea
          className="scm-commit-input"
          placeholder={`Message (${
            window.hive?.platform === 'darwin' ? '⌘' : 'Ctrl+'
          }Enter to commit)`}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={onCommitKeyDown}
          rows={2}
        />
        <div className="scm-commit-row">
          <button
            type="button"
            className="btn btn-primary btn-sm scm-commit-btn"
            disabled={amend ? isBusy || commitMessage.trim().length === 0 : commitDisabled}
            onClick={() => void (amend ? handleAmend() : handleCommit())}
          >
            <Icon name="check" size={13} /> {amend ? 'Amend' : 'Commit'}
          </button>
          <button
            type="button"
            className={'btn btn-sm scm-amend-btn' + (amend ? ' on' : '')}
            title="Amend the last commit"
            onClick={toggleAmend}
          >
            <Icon name="git-commit-horizontal" size={13} /> Amend
          </button>
        </div>
      </div>

      {buckets.conflicts.length > 0 && (
        <Section
          title="Merge Conflicts"
          count={buckets.conflicts.length}
          collapsed={collapsed.conflicts ?? false}
          onToggle={() => toggle('conflicts')}
        >
          {buckets.conflicts.map((e) => (
            <div key={`c-${e.path}`} className="scm-row scm-conflict-row">
              <span className="scm-badge cfl">C</span>
              <span className="scm-path">{e.path}</span>
              <span className="scm-actions">
                <button
                  type="button"
                  className="btn btn-sm scm-amend-btn"
                  title="Resolve in merge editor"
                  onClick={() => setMergeTarget({ repoPath: repo.path, path: e.path })}
                >
                  <Icon name="git-merge" size={12} /> Resolve
                </button>
                <button
                  type="button"
                  className="ib-btn scm-ib"
                  title="Stage (mark resolved)"
                  onClick={() => void handleStage(repo, e.path)}
                >
                  <Icon name="check" size={13} />
                </button>
              </span>
            </div>
          ))}
        </Section>
      )}

      {buckets.staged.length > 0 && (
        <Section
          title="Staged Changes"
          count={buckets.staged.length}
          collapsed={collapsed.staged ?? false}
          onToggle={() => toggle('staged')}
          actions={
            <button
              type="button"
              className="ib-btn scm-ib"
              title="Unstage all"
              onClick={(e) => {
                e.stopPropagation()
                void handleUnstageAll()
              }}
            >
              <Icon name="minus" size={13} />
            </button>
          }
        >
          {buckets.staged.map((e) => (
            <Row
              key={`s-${e.path}`}
              entry={e}
              repo={repo}
              section="staged"
              onOpenDiff={onOpenDiff}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onDiscard={handleDiscard}
            />
          ))}
        </Section>
      )}

      {buckets.unstaged.length > 0 && (
        <Section
          title="Changes"
          count={buckets.unstaged.length}
          collapsed={collapsed.unstaged ?? false}
          onToggle={() => toggle('unstaged')}
          actions={
            <>
              <button
                type="button"
                className="ib-btn scm-ib"
                title="Discard all changes"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleDiscardAll()
                }}
              >
                <Icon name="undo-2" size={13} />
              </button>
              <button
                type="button"
                className="ib-btn scm-ib"
                title="Stage all"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleStageAll()
                }}
              >
                <Icon name="plus" size={13} />
              </button>
            </>
          }
        >
          {buckets.unstaged.map((e) => (
            <Row
              key={`u-${e.path}`}
              entry={e}
              repo={repo}
              section="unstaged"
              onOpenDiff={onOpenDiff}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onDiscard={handleDiscard}
            />
          ))}
        </Section>
      )}

      {buckets.conflicts.length === 0 &&
        buckets.staged.length === 0 &&
        buckets.unstaged.length === 0 && (
          <div className="scm-clean">No changes</div>
        )}

      {stashes.length > 0 && (
        <Section
          title="Stashes"
          count={stashes.length}
          collapsed={collapsed.stashes ?? true}
          onToggle={() => toggle('stashes')}
        >
          {stashes.map((s) => (
            <div key={s.ref} className="scm-row scm-stash-row">
              <Icon name="archive" size={13} />
              <span className="scm-path" title={s.message}>
                {s.message}
              </span>
              <span className="scm-actions">
                <button
                  type="button"
                  className="ib-btn scm-ib"
                  title="Apply stash"
                  onClick={() => void stashOp('apply', s.ref)}
                >
                  <Icon name="copy-plus" size={13} />
                </button>
                <button
                  type="button"
                  className="ib-btn scm-ib"
                  title="Pop stash"
                  onClick={() => void stashOp('pop', s.ref)}
                >
                  <Icon name="arrow-up-from-line" size={13} />
                </button>
                <button
                  type="button"
                  className="ib-btn scm-ib"
                  title="Drop stash"
                  onClick={() => void stashOp('drop', s.ref)}
                >
                  <Icon name="trash-2" size={13} />
                </button>
              </span>
            </div>
          ))}
        </Section>
      )}

      {commits.length > 0 && (
        <Section
          title="History"
          count={commits.length}
          collapsed={collapsed.history ?? true}
          onToggle={() => toggle('history')}
        >
          {commits.map((c) => (
            <div key={c.hash} className="scm-commit-item" title={`${c.shortHash} · ${c.authorName}`}>
              <Icon name="git-commit-horizontal" size={13} />
              <div className="scm-commit-meta">
                <div className="scm-commit-subject">{c.subject}</div>
                <div className="scm-commit-sub">
                  {c.shortHash} · {c.authorName} · {formatRelativeTime(c.authorDate)}
                </div>
              </div>
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SourceControlView — top level
// ---------------------------------------------------------------------------

export default function SourceControlView() {
  const repos = useWorkspaceStore((s) => s.repos)
  const scm = useWorkspaceStore((s) => s.scm)
  const fetchAllScm = useWorkspaceStore((s) => s.fetchAllScm)

  const [busyRepos, setBusyRepos] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const setBusy = useCallback((repoPath: string, busy: boolean) => {
    setBusyRepos((prev) => {
      const next = new Set(prev)
      if (busy) next.add(repoPath)
      else next.delete(repoPath)
      return next
    })
  }, [])

  // Initial fetch + on-mount refresh.
  useEffect(() => {
    void fetchAllScm()
  }, [fetchAllScm])

  // Auto-refresh on filesystem changes from any tracked tree.
  const debounceRef = useRef<number | null>(null)
  useEffect(() => {
    const bridge = window.hive
    if (!bridge || typeof bridge.onFsChange !== 'function') return
    const unsub = bridge.onFsChange(() => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => {
        void fetchAllScm()
      }, 500)
    })
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      unsub()
    }
  }, [fetchAllScm])

  const gitRepos = repos.filter((r) => r.isGitRepo)

  return (
    <div className="view scm-view">
      <div className="scm-head">
        <span className="ttl">Source Control</span>
        <button
          type="button"
          className="ib-btn"
          title="Refresh all"
          onClick={() => void fetchAllScm()}
        >
          <Icon name="refresh-cw" size={14} />
        </button>
      </div>

      {error !== null && (
        <div className="scm-error">
          <span>{error}</span>
          <button
            type="button"
            className="ib-btn"
            title="Dismiss"
            onClick={() => setError(null)}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {gitRepos.length === 0 ? (
        <div className="scm-empty">
          No git repositories in this project.
        </div>
      ) : (
        gitRepos.map((r) => (
          <RepoBlock
            key={r.path}
            repo={r}
            scm={scm[r.path]}
            busyRepos={busyRepos}
            setBusy={setBusy}
            showError={setError}
          />
        ))
      )}
    </div>
  )
}

export { RepoBlock, Section, Row, bucketize, badgeFor }
