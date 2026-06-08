/**
 * Status bar (E11-01..E11-07).
 *
 * The persistent bottom bar. Renders left/right item slots from the
 * status-bar registry (`statusBarStore`), so any feature can contribute an
 * entry. Declarative items dispatch their `command` through the command
 * registry on click; complex items (the branch switcher, cursor position)
 * supply a `render` function instead.
 *
 * `useDefaultStatusItems` registers the built-in entries: git branch + sync,
 * live agent count, problem counts, and a couple of informational chips.
 * Editor-driven items (cursor position, language mode, indentation) are
 * registered by the editor as it gains focus (E11-02..E11-05).
 *
 * The whole bar hides when `workbench.statusBar.visible` is false.
 */

import { useEffect, useMemo, useState } from 'react'

import { Icon, Pulse } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useHiveSessionStore } from '../lib/useHiveSession'
import { useSettingsStore } from '../store/settingsStore'
import {
  sortedSide,
  useStatusBarStore,
  type StatusBarItem,
} from '../store/statusBarStore'
import { useCommandStore } from '../store/commandStore'
import { useProblemsStore, countDiagnostics } from '../store/problemsStore'

export function StatusBar() {
  useDefaultStatusItems()
  const items = useStatusBarStore((s) => s.items)
  const visible = useSettingsStore((s) => s.settings['workbench.statusBar.visible'])

  const left = useMemo(() => sortedSide(items, 'left'), [items])
  const right = useMemo(() => sortedSide(items, 'right'), [items])

  if (!visible) return null

  return (
    <div className="statusbar">
      {left.map((item) => (
        <StatusItem key={item.id} item={item} />
      ))}
      <div className="right">
        {right.map((item) => (
          <StatusItem key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}

function StatusItem({ item }: { item: StatusBarItem }) {
  const execute = useCommandStore((s) => s.execute)
  if (item.render) return <>{item.render()}</>

  const clickable = item.command !== undefined
  return (
    <span
      className={'sb-i' + (clickable ? ' sb-btn' : '')}
      title={item.tooltip}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      style={item.color ? { color: item.color } : undefined}
      onClick={
        clickable
          ? () => execute(item.command as string, ...(item.commandArgs ?? []))
          : undefined
      }
    >
      {item.icon && <Icon name={item.icon} size={13} />} {item.text}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Default items
// ---------------------------------------------------------------------------

function useDefaultStatusItems(): void {
  const register = useStatusBarStore((s) => s.register)
  useEffect(() => {
    const disposers = [
      register({
        id: 'scm.branch',
        alignment: 'left',
        priority: 100,
        render: () => <BranchStatusChip />,
      }),
      register({
        id: 'hive.agents',
        alignment: 'left',
        priority: 90,
        render: () => <AgentsLiveItem />,
      }),
      register({
        id: 'problems',
        alignment: 'left',
        priority: 80,
        render: () => <ProblemsItem />,
      }),
      register({
        id: 'editor.position',
        alignment: 'right',
        priority: 80,
        render: () => <CursorPositionItem />,
      }),
      register({
        id: 'editor.language',
        alignment: 'right',
        priority: 70,
        render: () => <LanguageModeItem />,
      }),
      register({
        id: 'terminal',
        alignment: 'right',
        priority: 40,
        icon: 'square-terminal',
        text: 'Terminal',
        tooltip: 'Open terminal',
        command: 'workbench.action.openTerminal',
      }),
      register({
        id: 'mempalace',
        alignment: 'right',
        priority: 20,
        icon: 'brain-circuit',
        text: 'mempalace · synced',
      }),
    ]
    return () => disposers.forEach((d) => d())
  }, [register])
}

function AgentsLiveItem() {
  const agents = useHiveSessionStore((s) => s.snapshot.agents)
  const live = agents.filter((a) => a.status === 'live').length
  return (
    <span className="sb-live">
      <Pulse /> {live} agents live
    </span>
  )
}

function ProblemsItem() {
  const byFile = useProblemsStore((s) => s.byFile)
  const counts = useMemo(() => countDiagnostics(byFile), [byFile])
  const execute = useCommandStore((s) => s.execute)
  return (
    <span
      className="sb-i sb-btn"
      onClick={() => execute('workbench.actions.view.problems')}
      role="button"
      tabIndex={0}
      title="Problems"
    >
      <Icon name="x-circle" size={13} /> {counts.errors}
      <Icon name="alert-triangle" size={13} style={{ marginLeft: 8 }} />{' '}
      {counts.warnings}
    </span>
  )
}

function CursorPositionItem() {
  const pos = useWorkspaceStore((s) => s.cursorPosition)
  if (!pos) return null
  const sel =
    pos.selectionLength && pos.selectionLength > 0
      ? ` (${pos.selectionLength} selected)`
      : ''
  return (
    <span className="sb-i" title="Cursor position">
      Ln {pos.line}, Col {pos.column}
      {sel}
    </span>
  )
}

function LanguageModeItem() {
  const lang = useWorkspaceStore((s) => s.activeLanguage)
  if (!lang) return null
  return (
    <span className="sb-i" title="Language mode">
      {lang}
    </span>
  )
}

// ---------------------------------------------------------------------------
// BranchStatusChip — REQ-008, relocated from App.tsx into the status bar.
//
// Shows the active project's primary repo's branch + ahead/behind. Click opens
// a dropdown to switch (when worktree is clean) or create a branch. Hides
// itself when there's no git repo in the project. Opening the SCM view to
// resolve a blocked switch is dispatched through the command registry.
// ---------------------------------------------------------------------------

function BranchStatusChip() {
  const project = useWorkspaceStore((s) => s.project)
  const repos = useWorkspaceStore((s) => s.repos)
  const scm = useWorkspaceStore((s) => s.scm)
  const fetchScm = useWorkspaceStore((s) => s.fetchScm)
  const fetchAllScm = useWorkspaceStore((s) => s.fetchAllScm)
  const execute = useCommandStore((s) => s.execute)

  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<{
    current: string
    local: string[]
    remote: string[]
  } | null>(null)
  const [creatingName, setCreatingName] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const primaryRepo = useMemo(
    () => repos.find((r) => r.isGitRepo) ?? null,
    [repos],
  )
  const slot = primaryRepo ? scm[primaryRepo.path] : undefined

  useEffect(() => {
    if (!open || !primaryRepo) return
    void window.hive.git
      .branches(primaryRepo.path)
      .then(setBranches)
      .catch(() => setBranches(null))
  }, [open, primaryRepo])

  useEffect(() => {
    if (toast === null) return
    const id = window.setTimeout(() => setToast(null), 3500)
    return () => window.clearTimeout(id)
  }, [toast])

  if (project === null || primaryRepo === null) return null

  const branchName = slot?.branch ?? '…'
  const dirty = (slot?.entries.length ?? 0) > 0

  async function switchBranch(name: string): Promise<void> {
    if (!primaryRepo) return
    if (dirty) {
      setToast('Repo has uncommitted changes — stash or commit before switching.')
      setOpen(false)
      execute('workbench.view.scm')
      return
    }
    try {
      await window.hive.git.checkout(primaryRepo.path, name, false)
      await fetchAllScm()
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    }
    setOpen(false)
  }

  async function createBranch(name: string): Promise<void> {
    if (!primaryRepo) return
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    try {
      await window.hive.git.checkout(primaryRepo.path, trimmed, true)
      await fetchScm(primaryRepo.path)
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    }
    setCreatingName(null)
    setOpen(false)
  }

  return (
    <>
      <span
        className="sb-i sb-btn"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        title={`Branch: ${branchName}${dirty ? ' — uncommitted changes' : ''}`}
      >
        <Icon name="git-branch" size={13} /> {branchName}
        {slot && slot.ahead > 0 && <span style={{ marginLeft: 4 }}>↑{slot.ahead}</span>}
        {slot && slot.behind > 0 && <span style={{ marginLeft: 4 }}>↓{slot.behind}</span>}
        {dirty && <span style={{ marginLeft: 4, opacity: 0.7 }}>●</span>}
      </span>

      {open && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 80 }}
            onClick={() => {
              setOpen(false)
              setCreatingName(null)
            }}
          />
          <div className="menu menu-branch">
            <div className="menu-head">Switch branch</div>
            {branches === null ? (
              <div className="menu-empty">Loading branches…</div>
            ) : (
              <>
                {branches.local.map((name) => (
                  <div
                    key={`l-${name}`}
                    className={
                      'menu-item' + (name === branches.current ? ' cur' : '')
                    }
                    onClick={() => void switchBranch(name)}
                    role="button"
                    tabIndex={0}
                  >
                    <Icon name="git-branch" size={14} />
                    <div className="mi-meta">
                      <div className="mi-n">{name}</div>
                    </div>
                    {name === branches.current && <Icon name="check" size={13} />}
                  </div>
                ))}
                {branches.remote.length > 0 && (
                  <div className="menu-head" style={{ marginTop: 4 }}>
                    Remote
                  </div>
                )}
                {branches.remote.map((name) => {
                  const localName = name.replace(/^[^/]+\//, '')
                  return (
                    <div
                      key={`r-${name}`}
                      className="menu-item"
                      onClick={() => void switchBranch(localName)}
                      role="button"
                      tabIndex={0}
                      title={`Create local tracking branch from ${name}`}
                    >
                      <Icon name="cloud" size={14} />
                      <div className="mi-meta">
                        <div className="mi-n">{name}</div>
                      </div>
                    </div>
                  )
                })}
                <div className="menu-foot">
                  {creatingName === null ? (
                    <button
                      type="button"
                      className="menu-foot-btn"
                      onClick={() => setCreatingName('')}
                    >
                      <Icon name="plus" size={14} />
                      Create new branch…
                    </button>
                  ) : (
                    <input
                      type="text"
                      autoFocus
                      placeholder="New branch name"
                      value={creatingName}
                      onChange={(e) => setCreatingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createBranch(creatingName)
                        else if (e.key === 'Escape') setCreatingName(null)
                      }}
                      style={{
                        width: '100%',
                        padding: '8px 10px',
                        background: 'var(--bg-surface)',
                        border: '1px solid var(--accent)',
                        borderRadius: 'var(--r-sm)',
                        color: 'var(--fg-1)',
                        font: 'var(--t-body-sm)',
                        outline: 'none',
                      }}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {toast !== null && (
        <div
          style={{
            position: 'fixed',
            right: 16,
            bottom: 30,
            zIndex: 250,
            padding: '8px 12px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--r-md)',
            color: 'var(--fg-1)',
            font: 'var(--t-body-sm)',
            boxShadow: 'var(--sh-md)',
            maxWidth: 420,
          }}
        >
          {toast}
        </div>
      )}
    </>
  )
}

export default StatusBar
