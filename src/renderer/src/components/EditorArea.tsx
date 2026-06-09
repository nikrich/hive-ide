/**
 * Editor area (E5-01) — hosts one or two side-by-side editor groups.
 *
 * Renders the primary group always, plus the secondary group when a split is
 * active (its tab list is non-empty). The two groups share the file content
 * cache, so the same document can be edited in both. Occupies the `editor`
 * grid cell as a flex row.
 */

import { EditorGroup } from './Editor'
import { useWorkspaceStore } from '../store/workspaceStore'

export function EditorArea() {
  const hasSecondary = useWorkspaceStore((s) => s.secondaryTabs.length > 0)

  return (
    <div className="editor-groups">
      <EditorGroup group="primary" />
      {hasSecondary && (
        <>
          <div className="editor-group-divider" />
          <EditorGroup group="secondary" />
        </>
      )}
    </div>
  )
}

export default EditorArea
