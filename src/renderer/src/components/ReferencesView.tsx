/**
 * References panel (E2-11).
 *
 * Lists the results of "find all references" grouped by file, click-to-reveal —
 * the list UI the backlog asks for beyond the built-in peek. Reads the
 * references store; opened by the find-references command.
 */

import { useMemo } from 'react'

import { Icon, fileIcon } from './primitives'
import { useReferencesStore } from '../store/referencesStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { ReferenceHit } from '../lib/references'

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

export function ReferencesView() {
  const open = useReferencesStore((s) => s.open)
  const symbol = useReferencesStore((s) => s.symbol)
  const hits = useReferencesStore((s) => s.hits)
  const close = useReferencesStore((s) => s.close)
  const revealInFile = useWorkspaceStore((s) => s.revealInFile)

  const groups = useMemo(() => {
    const byFile = new Map<string, ReferenceHit[]>()
    for (const h of hits) {
      const list = byFile.get(h.path) ?? []
      list.push(h)
      byFile.set(h.path, list)
    }
    return [...byFile.entries()]
  }, [hits])

  if (!open) return null

  return (
    <div className="settings-overlay">
      <div className="wsview">
        <div className="ws-toolbar">
          <button
            type="button"
            className="set-jsonbtn"
            title="Close"
            aria-label="Close references"
            onClick={close}
          >
            <Icon name="arrow-left" size={13} />
          </button>
          <div className="ws-title">
            <Icon name="search-code" size={15} /> References
            <span className="cnt">
              {hits.length} to “{symbol}” in {groups.length} file
              {groups.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="srch-results">
          {hits.length === 0 && (
            <div className="srch-status">No references found.</div>
          )}
          {groups.map(([file, fileHits]) => {
            const [icon, tint] = fileIcon(basename(file))
            return (
              <div key={file} className="srch-group">
                <div className="srch-filerow">
                  <span className={'fi ' + tint}>
                    <Icon name={icon} size={13} />
                  </span>
                  <span className="srch-filename">{basename(file)}</span>
                  <span className="srch-count">{fileHits.length}</span>
                </div>
                {fileHits.map((h, i) => (
                  <div
                    // eslint-disable-next-line react/no-array-index-key
                    key={i}
                    className="srch-matchrow"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      revealInFile(h.path, h.line, h.column)
                      close()
                    }}
                  >
                    <span className="srch-lineno">{h.line}</span>
                    <span className="srch-preview">{h.preview}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default ReferencesView
