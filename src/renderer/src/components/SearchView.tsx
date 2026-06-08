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

export interface SearchViewProps {
  onClose?: () => void
}

export function SearchView({ onClose }: SearchViewProps) {
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
  const [result, setResult] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement | null>(null)

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
        .files({ roots, query, options: opts, exclude })
        .then((res) => {
          if (cancelled) return
          setResult(res)
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
  }, [query, opts, roots, exclude])

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
    const files = result.results.map((r) => r.file)
    setReplacing(true)
    try {
      const res = await bridge.replace({ files, query, replacement, options: opts })
      // Re-run the search so the now-stale matches refresh (files were edited
      // on disk; the open editors pick up changes via the fs-change pipeline).
      const fresh = await bridge.files({ roots, query, options: opts, exclude })
      setResult(fresh)
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
        {onClose && (
          <button
            type="button"
            className="set-jsonbtn"
            title="Close search"
            aria-label="Close search"
            onClick={onClose}
          >
            <Icon name="arrow-left" size={13} />
          </button>
        )}
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
          return (
            <div key={group.file} className="srch-group">
              <div
                className="srch-filerow"
                onClick={() => toggleCollapse(group.file)}
                role="button"
                tabIndex={0}
              >
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
                  <div
                    // eslint-disable-next-line react/no-array-index-key
                    key={i}
                    className="srch-matchrow"
                    onClick={() => {
                      revealInFile(group.file, m.line, (m.ranges[0]?.start ?? 0) + 1)
                      onClose?.()
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <span className="srch-lineno">{m.line}</span>
                    <span className="srch-preview">
                      <Highlighted text={m.preview} ranges={m.ranges} />
                    </span>
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
