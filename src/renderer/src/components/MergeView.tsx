/**
 * Merge conflict resolver (E7-06).
 *
 * Loads a conflicted working-tree file, parses its conflict markers, and lets
 * the user resolve each conflict (accept current / incoming / both) with a live
 * preview. "Complete Merge" writes the resolved file, stages it, and refreshes
 * SCM. Reads the merge target from the workspace store; opened from an SCM
 * conflict row.
 */

import { useEffect, useMemo, useState } from 'react'

import { Icon } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'
import { notify } from '../store/notificationsStore'
import {
  allResolved,
  parseConflicts,
  serialize,
  type ConflictSegment,
  type MergeSegment,
} from '../lib/mergeConflicts'

export function MergeView() {
  const target = useWorkspaceStore((s) => s.mergeTarget)
  const setMergeTarget = useWorkspaceStore((s) => s.setMergeTarget)
  const fetchScm = useWorkspaceStore((s) => s.fetchScm)
  const [segments, setSegments] = useState<MergeSegment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const absPath = useMemo(() => {
    if (!target) return ''
    const sep = target.repoPath.includes('\\') ? '\\' : '/'
    const root = target.repoPath.endsWith(sep)
      ? target.repoPath.slice(0, -1)
      : target.repoPath
    return `${root}${sep}${target.path.split('/').join(sep)}`
  }, [target])

  useEffect(() => {
    if (!target) return
    let cancelled = false
    setSegments(null)
    setError(null)
    void window.hive.fs
      .readFile(absPath)
      .then(({ contents }) => {
        if (!cancelled) setSegments(parseConflicts(contents))
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [absPath, target])

  if (!target) return null

  const resolve = (idx: number, choice: ConflictSegment['resolution']): void => {
    setSegments((prev) =>
      (prev ?? []).map((s, i) =>
        i === idx && s.type === 'conflict' ? { ...s, resolution: choice } : s,
      ),
    )
  }

  const resolveAll = (choice: ConflictSegment['resolution']): void => {
    setSegments((prev) =>
      (prev ?? []).map((s) => (s.type === 'conflict' ? { ...s, resolution: choice } : s)),
    )
  }

  const complete = async (): Promise<void> => {
    if (!segments) return
    setBusy(true)
    try {
      await window.hive.fs.writeFile(absPath, serialize(segments))
      await window.hive.git.stage(target.repoPath, [target.path])
      await fetchScm(target.repoPath)
      notify('info', `Resolved conflicts in ${target.path}`)
      setMergeTarget(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const conflictCount = (segments ?? []).filter((s) => s.type === 'conflict').length
  const ready = segments !== null && allResolved(segments)

  return (
    <div className="wsview">
      <div className="ws-toolbar">
        <button
          type="button"
          className="set-jsonbtn"
          title="Close"
          aria-label="Close merge resolver"
          onClick={() => setMergeTarget(null)}
        >
          <Icon name="arrow-left" size={13} />
        </button>
        <div className="ws-title">
          <Icon name="git-merge" size={15} /> Resolve Conflicts
          <span className="cnt">{target.path}</span>
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" className="set-jsonbtn" onClick={() => resolveAll('current')}>
          Accept All Current
        </button>
        <button type="button" className="set-jsonbtn" onClick={() => resolveAll('incoming')}>
          Accept All Incoming
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!ready || busy}
          onClick={() => void complete()}
        >
          <Icon name="check" size={13} /> Complete Merge
        </button>
      </div>

      {error && <div className="plug-note err"><Icon name="alert-triangle" size={15} /> {error}</div>}

      <div className="merge-body">
        {segments === null && !error && <div className="dbg-empty">Loading…</div>}
        {segments !== null && conflictCount === 0 && (
          <div className="dbg-empty">No conflicts found in this file.</div>
        )}
        {(segments ?? []).map((seg, i) =>
          seg.type === 'text' ? (
            seg.lines.some((l) => l.trim() !== '') ? (
              // eslint-disable-next-line react/no-array-index-key
              <pre key={i} className="merge-text">
                {seg.lines.join('\n')}
              </pre>
            ) : null
          ) : (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className={'merge-conflict res-' + (seg.resolution ?? 'none')}>
              <div className="merge-side current">
                <div className="merge-side-head">
                  <span>Current ({seg.currentLabel})</span>
                  <button type="button" onClick={() => resolve(i, 'current')}>
                    Accept Current
                  </button>
                </div>
                <pre>{seg.current.join('\n')}</pre>
              </div>
              <div className="merge-side incoming">
                <div className="merge-side-head">
                  <span>Incoming ({seg.incomingLabel})</span>
                  <button type="button" onClick={() => resolve(i, 'incoming')}>
                    Accept Incoming
                  </button>
                </div>
                <pre>{seg.incoming.join('\n')}</pre>
              </div>
              <div className="merge-both">
                <button type="button" onClick={() => resolve(i, 'both')}>
                  Accept Both
                </button>
                {seg.resolution && (
                  <span className="merge-chosen">
                    <Icon name="check" size={12} /> {seg.resolution}
                  </span>
                )}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  )
}

export default MergeView
