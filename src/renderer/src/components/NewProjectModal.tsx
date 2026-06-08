/**
 * NewProjectModal — REQ-003 explicit-project creation flow.
 *
 * The user gives the project a name and optionally adds one or more
 * folders as repos. On Create the modal calls `store.createProject(name)`,
 * then `store.addRepoToProject(path)` once per pending repo. The modal
 * never blocks on the folder picker — failures are surfaced as inline
 * messages so the user can retry without losing the rest of the form.
 *
 * File-ownership: owns NewProjectModal.tsx exclusively. Reuses the
 * `.cmd-overlay` pattern from CommandPalette for the backdrop + rise
 * animation so the visual language stays consistent.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { InspectedFolder } from '../../../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import { Btn, Icon } from './primitives'

export interface NewProjectModalProps {
  onClose: () => void
  /**
   * Optional override for the project name's initial value. Useful when the
   * "Add Folder…" item in the project switcher pre-fills based on the chosen
   * folder's basename.
   */
  initialName?: string
}

export function NewProjectModal({ onClose, initialName = '' }: NewProjectModalProps) {
  const createProject = useWorkspaceStore((s) => s.createProject)
  const addRepoToProject = useWorkspaceStore((s) => s.addRepoToProject)
  const setHiveWorkspacePath = useWorkspaceStore((s) => s.setHiveWorkspacePath)

  const [name, setName] = useState(initialName)
  const [pending, setPending] = useState<InspectedFolder[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

  // ----- folder picker --------------------------------------------------
  const handlePickFolder = useCallback(async () => {
    setError(null)
    try {
      const result = await window.hive.project.openDialog()
      if (result.canceled || !result.path) return
      // Reject duplicates silently — the row already exists.
      if (pending.some((p) => p.path === result.path)) return
      const inspected = await window.hive.project.inspectFolder(result.path)
      setPending((prev) => [...prev, inspected])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add folder')
    }
  }, [pending])

  const handleRemovePending = useCallback((path: string) => {
    setPending((prev) => prev.filter((p) => p.path !== path))
  }, [])

  // ----- create ---------------------------------------------------------
  const trimmedName = name.trim()
  const canCreate = trimmedName.length > 0 && !busy

  const handleCreate = useCallback(async () => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const project = createProject(trimmedName)
      // addRepoToProject is fire-and-forget per the store contract; if
      // any one fails we surface the message but keep the project around.
      for (const folder of pending) {
        await addRepoToProject(folder.path)
      }
      // Auto-create + bind the IDE-managed hive workspace so the board is live.
      try {
        const { workspacePath } = await window.hive.workspace.ensure(project.id)
        setHiveWorkspacePath(workspacePath)
        await window.hive.orchestration.setWorkspace(workspacePath)
      } catch (wsErr) {
        // Non-fatal: the project still exists; hive can be initialized later
        // from the Dock. Surface but don't block project creation.
        // eslint-disable-next-line no-console
        console.error('hive workspace init failed', wsErr)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create project')
      setBusy(false)
    }
  }, [addRepoToProject, canCreate, createProject, onClose, pending, setHiveWorkspacePath, trimmedName])

  // ----- key handlers ---------------------------------------------------
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void handleCreate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleCreate, onClose])

  // ----- render ---------------------------------------------------------
  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div
        className="cmd new-project-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
      >
        <div className="np-head">
          <h2 id="new-project-title" className="np-title">New Project</h2>
          <button
            type="button"
            className="np-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="np-body">
          <label className="np-field">
            <span className="np-label">Project name</span>
            <input
              ref={nameInputRef}
              type="text"
              className="np-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. acme, my-side-project"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>

          <div className="np-field">
            <div className="np-label-row">
              <span className="np-label">Folders</span>
              <span className="np-hint">
                {pending.length === 0
                  ? 'None added yet'
                  : `${pending.length} folder${pending.length === 1 ? '' : 's'} added`}
              </span>
            </div>

            {pending.length > 0 && (
              <ul className="np-list">
                {pending.map((p) => (
                  <li key={p.path} className="np-list-item">
                    <Icon name={p.isGitRepo ? 'git-branch' : 'folder'} size={14} />
                    <span className="np-item-meta">
                      <span className="np-item-name">{p.name}</span>
                      <span className="np-item-path" title={p.path}>{p.path}</span>
                    </span>
                    <button
                      type="button"
                      className="np-item-remove"
                      onClick={() => handleRemovePending(p.path)}
                      aria-label={`Remove ${p.name}`}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <Btn kind="ghost" icon="folder-plus" onClick={handlePickFolder}>
              Add Folder…
            </Btn>
          </div>

          {error && <div className="np-error">{error}</div>}
        </div>

        <div className="np-foot">
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn
            kind="amber"
            icon="check"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
          >
            Create project
          </Btn>
        </div>
      </div>
    </div>
  )
}

export default NewProjectModal
