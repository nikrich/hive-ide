import { useState } from 'react'

import type { NewRequirementFields } from '../../../types/hive'
import { Btn, Icon } from './primitives'

export interface NewRequirementModalProps {
  onClose: () => void
  onCreate: (fields: NewRequirementFields) => void
}

/**
 * Author a hive requirement from the UI (slice 2b-2b). Collects a title + a
 * high-level description; on submit hands `NewRequirementFields` to the caller
 * (which calls `window.hive.requirement.create`). The manager then decomposes
 * it into proposed stories the operator reviews. Reuses NewStoryModal's `ns-*`
 * CSS so the form matches the dark IDE theme.
 */
export function NewRequirementModal({ onClose, onCreate }: NewRequirementModalProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const canCreate = title.trim() !== ''

  const submit = (): void => {
    if (!canCreate) return
    onCreate({ title: title.trim(), body })
  }

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div
        className="cmd new-story-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-req-title"
      >
        <div className="ns-head">
          <h2 id="new-req-title" className="ns-title">New requirement</h2>
          <button type="button" className="ns-close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="ns-body">
          <label className="ns-field">
            <span className="ns-label">Title</span>
            <input
              className="ns-input"
              aria-label="Title"
              placeholder="Add OAuth login across the stack"
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
              placeholder="Describe the outcome you want. Hive decomposes it into routed stories."
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        </div>

        <div className="ns-foot">
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="cta" disabled={!canCreate} onClick={submit}>Create requirement</Btn>
        </div>
      </div>
    </div>
  )
}

export default NewRequirementModal
