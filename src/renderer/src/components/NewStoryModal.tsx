import { useState } from 'react'

import type { HiveRole, NewStoryFields } from '../../../types/hive'
import { Btn, Icon } from './primitives'

const ROLES: readonly HiveRole[] = [
  'manager', 'tech-lead', 'senior', 'intermediate', 'junior', 'qa',
]

let CRIT_SEQ = 0
const newCrit = (): { id: string; text: string } => ({ id: `c${CRIT_SEQ++}`, text: '' })

export interface NewStoryModalProps {
  onClose: () => void
  onCreate: (fields: NewStoryFields) => void
}

/**
 * Author a hive story from the UI (slice 2c). Collects title, description,
 * role, and an add/remove acceptance-criteria list. The target repo (team) is
 * NOT chosen here — hive decides where the work runs (the manager loop assigns
 * it; until then an empty team falls back to the project's first repo).
 * Submit hands `NewStoryFields` to the caller (which calls
 * `window.hive.story.create`); the slice-1 watcher then renders the card.
 *
 * Styling mirrors NewProjectModal's `np-*` system (see `styles/ide.css`,
 * `.new-story-modal` block) so the form controls match the dark IDE theme.
 */
export function NewStoryModal({ onClose, onCreate }: NewStoryModalProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [role, setRole] = useState<HiveRole>('senior')
  const [criteria, setCriteria] = useState(() => [newCrit()])

  const canCreate = title.trim() !== ''

  const submit = (): void => {
    if (!canCreate) return
    onCreate({
      title: title.trim(),
      body,
      role,
      // Team is left unassigned — hive decides which repo the work runs in.
      // (Interim: an empty team falls back to the project's first repo; the
      // manager loop assigns the right team in a later slice.)
      team: '',
      acceptanceCriteria: criteria.map((c) => c.text.trim()).filter((t) => t !== ''),
    })
  }

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div
        className="cmd new-story-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-story-title"
      >
        <div className="ns-head">
          <h2 id="new-story-title" className="ns-title">New story</h2>
          <button
            type="button"
            className="ns-close"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="ns-body">
          <label className="ns-field">
            <span className="ns-label">Title</span>
            <input
              className="ns-input"
              aria-label="Title"
              placeholder="Add a login form"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </label>

          <label className="ns-field">
            <span className="ns-label">Description</span>
            <textarea
              className="ns-input ns-textarea"
              aria-label="Description"
              placeholder="What should the agent build? Be specific."
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>

          <label className="ns-field">
            <span className="ns-label">Role</span>
            <select
              className="ns-input ns-select"
              aria-label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as HiveRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>

          <div className="ns-field">
            <span className="ns-label">Acceptance criteria</span>
            <div className="ns-crit-list">
              {criteria.map((c, i) => (
                <div key={c.id} className="ns-crit-row">
                  <input
                    className="ns-input"
                    aria-label={`Acceptance criterion ${i + 1}`}
                    placeholder={`Criterion ${i + 1}`}
                    value={c.text}
                    onChange={(e) =>
                      setCriteria((prev) =>
                        prev.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="ns-crit-remove"
                    aria-label={`Remove criterion ${i + 1}`}
                    onClick={() =>
                      setCriteria((prev) =>
                        prev.length === 1 ? [newCrit()] : prev.filter((x) => x.id !== c.id),
                      )
                    }
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="ns-add-crit"
              onClick={() => setCriteria((prev) => [...prev, newCrit()])}
            >
              <Icon name="plus" size={14} /> Add criterion
            </button>
          </div>
        </div>

        <div className="ns-foot">
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="cta" disabled={!canCreate} onClick={submit}>Create story</Btn>
        </div>
      </div>
    </div>
  )
}

export default NewStoryModal
