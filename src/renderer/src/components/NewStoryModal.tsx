import { useState } from 'react'

import type { HiveRole, NewStoryFields } from '../../../types/hive'
import type { Repo } from '../../../types/workspace'
import { Btn } from './primitives'

const ROLES: readonly HiveRole[] = [
  'manager', 'tech-lead', 'senior', 'intermediate', 'junior', 'qa',
]

let CRIT_SEQ = 0
const newCrit = (): { id: string; text: string } => ({ id: `c${CRIT_SEQ++}`, text: '' })

export interface NewStoryModalProps {
  repos: readonly Repo[]
  onClose: () => void
  onCreate: (fields: NewStoryFields) => void
}

/**
 * Author a hive story from the UI (slice 2c). Collects title, description,
 * role, team (a project repo), and an add/remove acceptance-criteria list.
 * Submit hands `NewStoryFields` to the caller (which calls
 * `window.hive.story.create`); the slice-1 watcher then renders the card.
 */
export function NewStoryModal({ repos, onClose, onCreate }: NewStoryModalProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [role, setRole] = useState<HiveRole>('senior')
  const [team, setTeam] = useState(repos[0]?.name ?? '')
  const [criteria, setCriteria] = useState(() => [newCrit()])

  const canCreate = title.trim() !== '' && team !== ''

  const submit = (): void => {
    if (!canCreate) return
    onCreate({
      title: title.trim(),
      body,
      role,
      team,
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
        <h2 id="new-story-title" style={{ font: 'var(--t-h3)', margin: '0 0 12px' }}>
          New story
        </h2>

        <label style={{ display: 'block', marginBottom: 10 }}>
          <div className="field-label">Title</div>
          <input
            aria-label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>

        <label style={{ display: 'block', marginBottom: 10 }}>
          <div className="field-label">Description</div>
          <textarea
            aria-label="Description"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
          <label style={{ flex: 1 }}>
            <div className="field-label">Role</div>
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as HiveRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1 }}>
            <div className="field-label">Team (repo)</div>
            <select aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}>
              {repos.map((r) => (
                <option key={r.path} value={r.name}>{r.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="field-label">Acceptance criteria</div>
        {criteria.map((c, i) => (
          <div key={c.id} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              aria-label={`Acceptance criterion ${i + 1}`}
              value={c.text}
              onChange={(e) =>
                setCriteria((prev) =>
                  prev.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)),
                )
              }
              style={{ flex: 1 }}
            />
            <Btn
              kind="ghost"
              sm
              icon="x"
              aria-label={`Remove criterion ${i + 1}`}
              onClick={() =>
                setCriteria((prev) =>
                  prev.length === 1 ? [newCrit()] : prev.filter((x) => x.id !== c.id),
                )
              }
            >{''}</Btn>
          </div>
        ))}
        <Btn kind="ghost" sm icon="plus" onClick={() => setCriteria((prev) => [...prev, newCrit()])}>
          Add criterion
        </Btn>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="cta" disabled={!canCreate} onClick={submit}>Create story</Btn>
        </div>
      </div>
    </div>
  )
}

export default NewStoryModal
