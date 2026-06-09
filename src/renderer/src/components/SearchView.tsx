/**
 * Global search view (E2-02).
 *
 * A workarea panel that runs a project-wide content search through the
 * main-process engine (E2-01) and renders the results grouped by file. Each
 * file group is collapsible; clicking a match opens the file and reveals the
 * line (via the store's one-shot `revealInFile`).
 *
 * Options (case / whole-word / regex) toggle inline; the query is debounced.
 * The exclude globs come from the `search.exclude` setting (E2-05).
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { Icon, fileIcon } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useSettingsStore } from '../store/settingsStore'
import { notify } from '../store/notificationsStore'
import { progress } from '../store/progressStore'
import type {
  SearchFileResult,
  SearchOptions,
  SearchResult,
} from '../../../preload/api'

const DEBOUNCE_MS = 220

function basename(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/'
  const i = p.lastIndexOf(sep)
  return i === -1 ? p : p.slice(i + 1)
}

function dirname(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/'
  const i = p.lastIndexOf(sep)
  return i === -1 ? '' : p.slice(0, i)
}

/** Render a line preview with the match ranges highlighted. */
function Highlighted({
  text,
  ranges,
}: {
  text: string
  ranges: ReadonlyArray<{ start: number; end: number }>
}) {
  if (ranges.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let cursor = 0
  ranges.forEach((r, i) => {
    if (r.start > cursor) parts.push(text.slice(cursor, r.start))
    parts.push(
      <mark key={i} className="srch-hit">
        {text.slice(r.start, r.end)}
      </mark>,
    )
    cursor = r.end
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

export function SearchView() {
  const repos = useWorkspaceStore((s) => s.repos)
  const revealInFile = useWorkspaceStore((s) => s.revealInFile)
  const exclude = useSettingsStore((s) => s.settings['search.exclude'])

  // Persisted last query + options (E2-09).
  const persisted = useMemo(() => {
    try {
      const raw = localStorage.getItem('hive.search.last')
      return raw ? (JSON.parse(raw) as { query?: string; opts?: SearchOptions }) : null
    } catch {
      return null
    }
  }, [])

  const [query, setQuery] = useState(persisted?.query ?? '')
  const [replacement, setReplacement] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [opts, setOpts] = useState<SearchOptions>(persisted?.opts ?? {})
  const [showContext, setShowContext] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Per-match opt-out (E2-04): keys are `${file}\n${line}` — \n is safe in
  // both POSIX and Windows paths, unlike ':'.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement | null>(null)

  const matchKey = (file: string, line: number): string => `${file}\n${line}`

  const toggleMatch = (file: string, line: number): void =>
    setExcluded((prev) => {
      const next = new Set(prev)
      const key = matchKey(file, line)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const toggleFile = (group: SearchFileResult): void =>
    setExcluded((prev) => {
      const next = new Set(prev)
      const keys = group.matches.map((m) => matchKey(group.file, m.line))
      const allExcluded = keys.every((k) => next.has(k))
      for (const k of keys) {
        if (allExcluded) next.delete(k)
        else next.add(k)
      }
      return next
    })

  const roots = useMemo(() => repos.map((r) => r.path), [repos])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Persist the last query + options so reopening Search restores them (E2-09).
  useEffect(() => {
    try {
      localStorage.setItem('hive.search.last', JSON.stringify({ query, opts }))
    } catch {
      // storage may be unavailable; non-fatal
    }
  }, [query, opts])

  // Debounced search whenever query / options / roots change.
  useEffect(() => {
    if (query.trim() === '') {
      setResult(null)
      setError(null)
      setSearching(false)
      return
    }
    const bridge = window.hive?.search
    if (!bridge || roots.length === 0) return

    let cancelled = false
    setSearching(true)
    const handle = window.setTimeout(() => {
      progress.start('search', `Searching: ${query}`)
      void bridge
        .files({ roots, query, options: opts, exclude, contextLines: showContext ? 2 : 0 })
        .then((res) => {
          if (cancelled) return
          setResult(res)
          setExcluded(new Set())
          setError(null)
        })
        .catch((e) => {
          if (cancelled) return
          setError(e instanceof Error ? e.message : String(e))
          setResult(null)
        })
        .finally(() => {
          progress.end('search')
          if (!cancelled) setSearching(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [query, opts, roots, exclude, showContext])

  const toggleCollapse = (file: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })

  const fileCount = result?.results.length ?? 0

  async function applyReplaceAll(): Promise<void> {
    const bridge = window.hive?.search
    if (!bridge || !result || result.results.length === 0) return
    const excludeLines: Record<string, number[]> = {}
    const files: string[] = []
    for (const group of result.results) {
      const skipped = group.matches
        .map((m) => m.line)
        .filter((line) => excluded.has(matchKey(group.file, line)))
      if (skipped.length === group.matches.length) continue // whole file opted out
      files.push(group.file)
      if (skipped.length > 0) excludeLines[group.file] = skipped
    }
    if (files.length === 0) {
      notify('warning', 'All matches are excluded from replace.')
      return
    }
    setReplacing(true)
    try {
      const res = await bridge.replace({
        files,
        query,
        replacement,
        options: opts,
        ...(Object.keys(excludeLines).length > 0 ? { excludeLines } : {}),
      })
      // Re-run the search so the now-stale matches refresh (files were edited
      // on disk; the open editors pick up changes via the fs-change pipeline).
      const fresh = await bridge.files({ roots, query, options: opts, exclude })
      setResult(fresh)
      setExcluded(new Set())
      setError(null)
      notify(
        res.filesChanged === 0 ? 'warning' : 'info',
        res.filesChanged === 0
          ? 'No replacements were applied.'
          : `Replaced ${res.replacements} occurrence${res.replacements === 1 ? '' : 's'} across ${res.filesChanged} file${res.filesChanged === 1 ? '' : 's'}.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setReplacing(false)
    }
  }

  return (
    <div className="wsview">
      <div className="ws-toolbar">
        <div className="ws-title">
          <Icon name="search" size={15} /> Search
          {result && (
            <span className="cnt">
              {result.total} result{result.total === 1 ? '' : 's'} in {fileCount}{' '}
              file{fileCount === 1 ? '' : 's'}
              {result.truncated ? ' (truncated)' : ''}
            </span>
          )}
        </div>
      </div>

      <div className="srch-controls">
        <div className="srch-inputrow">
          <button
            type="button"
            className={'srch-opt' + (showReplace ? ' on' : '')}
            title="Toggle Replace"
            aria-label="Toggle replace"
            onClick={() => setShowReplace((v) => !v)}
          >
            <Icon name={showReplace ? 'chevron-down' : 'chevron-right'} size={14} />
          </button>
          <input
            ref={inputRef}
            className="srch-input"
            value={query}
            placeholder="Search across the project"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search query"
          />
          <button
            type="button"
            className={'srch-opt' + (opts.caseSensitive ? ' on' : '')}
            title="Match Case"
            onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
          >
            Aa
          </button>
          <button
            type="button"
            className={'srch-opt' + (opts.wholeWord ? ' on' : '')}
            title="Match Whole Word"
            onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}
          >
            <span style={{ textDecoration: 'underline' }}>ab</span>
          </button>
          <button
            type="button"
            className={'srch-opt' + (opts.regex ? ' on' : '')}
            title="Use Regular Expression"
            onClick={() => setOpts((o) => ({ ...o, regex: !o.regex }))}
          >
            .*
          </button>
          <button
            type="button"
            className={'srch-opt' + (showContext ? ' on' : '')}
            title="Show context lines"
            aria-label="Toggle context lines"
            onClick={() => setShowContext((v) => !v)}
          >
            <Icon name="text" size={13} />
          </button>
        </div>
        {showReplace && (
          <div className="srch-inputrow" style={{ marginTop: 6 }}>
            <span style={{ width: 28, flex: 'none' }} />
            <input
              className="srch-input"
              value={replacement}
              placeholder="Replace"
              onChange={(e) => setReplacement(e.target.value)}
              aria-label="Replacement text"
            />
            <button
              type="button"
              className="srch-opt"
              title="Replace All"
              aria-label="Replace all"
              disabled={replacing || !result || fileCount === 0}
              onClick={() => void applyReplaceAll()}
            >
              <Icon name="replace-all" size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="srch-results">
        {error && <div className="srch-error">{error}</div>}
        {!error && searching && <div className="srch-status">Searching…</div>}
        {!error && !searching && query.trim() !== '' && fileCount === 0 && (
          <div className="srch-status">No results found.</div>
        )}
        {result?.results.map((group: SearchFileResult) => {
          const isCollapsed = collapsed.has(group.file)
          const [icon, tint] = fileIcon(basename(group.file))
          const excludedCount = group.matches.filter((m) =>
            excluded.has(matchKey(group.file, m.line)),
          ).length
          return (
            <div key={group.file} className="srch-group">
              <div
                className="srch-filerow"
                onClick={() => toggleCollapse(group.file)}
                role="button"
                tabIndex={0}
              >
                <input
                  type="checkbox"
                  className="srch-include"
                  aria-label={`Include file ${group.file}`}
                  // Tri-state: indeterminate when only some of the file's
                  // matches are excluded; checked unless ALL are excluded.
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        excludedCount > 0 && excludedCount < group.matches.length
                  }}
                  checked={excludedCount < group.matches.length}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleFile(group)}
                />
                <Icon
                  name={isCollapsed ? 'chevron-right' : 'chevron-down'}
                  size={13}
                />
                <span className={'fi ' + tint}>
                  <Icon name={icon} size={13} />
                </span>
                <span className="srch-filename">{basename(group.file)}</span>
                <span className="srch-filedir">{dirname(group.file)}</span>
                <span className="srch-count">{group.matches.length}</span>
              </div>
              {!isCollapsed &&
                group.matches.map((m, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={i} className="srch-matchblock">
                    {(m.before ?? []).map((c, j) => (
                      <div key={`b${j}`} className="srch-matchrow srch-context">
                        <span className="srch-lineno">
                          {m.line - (m.before?.length ?? 0) + j}
                        </span>
                        <span className="srch-preview">{c}</span>
                      </div>
                    ))}
                    <div
                      className="srch-matchrow"
                      onClick={() => {
                        revealInFile(group.file, m.line, (m.ranges[0]?.start ?? 0) + 1)
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <input
                        type="checkbox"
                        className="srch-include"
                        aria-label={`Include match ${group.file}:${m.line}`}
                        checked={!excluded.has(matchKey(group.file, m.line))}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleMatch(group.file, m.line)}
                      />
                      <span className="srch-lineno">{m.line}</span>
                      <span className="srch-preview">
                        <Highlighted text={m.preview} ranges={m.ranges} />
                      </span>
                    </div>
                    {(m.after ?? []).map((c, j) => (
                      <div key={`a${j}`} className="srch-matchrow srch-context">
                        <span className="srch-lineno">{m.line + 1 + j}</span>
                        <span className="srch-preview">{c}</span>
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default SearchView
