/**
 * Hive IDE — ⌘K command palette overlay.
 *
 * A self-contained overlay that lets the operator search across three groups
 * of targets:
 *   - Actions  : top-level navigation verbs (PRs, hub, spawn, toggle
 *                terminal, switch branch)
 *   - Projects : one entry per project in the workspace; selecting one
 *                routes to that project view via `onNav('proj:<id>')`
 *   - Files    : every file path in the supplied tree, opened via
 *                `onOpenFile(path)`
 *
 * Open/close state and the global ⌘K binding live in the App shell
 * (STORY-014). This component is purely the overlay UI: when the parent
 * mounts it the input auto-focuses; the operator types to filter, uses
 * Arrow keys + Enter to activate the highlighted item, and Escape (or a
 * click on the dimmed backdrop) to close.
 *
 * The markup mirrors the prototype in `design-reference/hub.jsx` so the
 * existing CSS in `styles/ide.css` (`.cmd-overlay`, `.cmd`, `.cmd-in`,
 * `.cmd-list`, `.cmd-sec`, `.cmd-item`) lights it up unchanged.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Icon } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'

// ---------------------------------------------------------------------------
// Public component contract
// ---------------------------------------------------------------------------

export interface CommandPaletteProps {
  /** Called when the operator dismisses the palette (Escape, backdrop, or after activating an item). */
  onClose: () => void
  /**
   * Top-level navigation hook. Receives one of:
   *   - `'prs'`        — Pull requests view
   *   - `'hub'`        — Projects hub
   *   - `'terminal'`   — Toggle bottom-panel terminal
   *   - `'proj:<id>'`  — Open a specific recent project (id = `RecentEntry.id`)
   *
   * Other string targets may be added later; the palette treats this as an
   * opaque routing key.
   */
  onNav: (target: string) => void
  /** Called with an absolute file path when a Files row is activated. */
  onOpenFile: (file: string) => void
}

// ---------------------------------------------------------------------------
// Internal item shape
// ---------------------------------------------------------------------------

type PaletteKind = 'action' | 'project' | 'file'

interface PaletteItem {
  kind: PaletteKind
  icon: string
  /** Title — large text on the row. */
  t: string
  /** Detail — smaller mono text on the right of the row. */
  d: string
  /** Run when the row is activated (Enter or click). */
  go: () => void
}

/** Last path segment of an absolute path. */
function basename(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/'
  const i = p.lastIndexOf(sep)
  return i === -1 ? p : p.slice(i + 1)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette({
  onClose,
  onNav,
  onOpenFile,
}: CommandPaletteProps) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Pull the Projects / Files groups straight off the store so the palette
  // surfaces the *real* recents list + the currently-open tabs. Full
  // project-wide quick-open over the filesystem is its own future story
  // (see the spec — `⌘P opens quick-file picker scoped to active project's
  // repos`).
  const recents = useWorkspaceStore((s) => s.recents)
  const openTabs = useWorkspaceStore((s) => s.openTabs)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Build the full item list once per (recents, openTabs) pair. The
  // filtering step below is cheap enough to redo on every keystroke.
  const all = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { kind: 'action', icon: 'git-pull-request', t: 'View pull requests', d: 'PRs', go: () => onNav('prs') },
      { kind: 'action', icon: 'layout-dashboard', t: 'Open Projects hub', d: 'Workspace', go: () => onNav('hub') },
      { kind: 'action', icon: 'folder-plus', t: 'Open Folder…', d: 'Workspace', go: () => onNav('hub') },
      { kind: 'action', icon: 'square-terminal', t: 'Toggle terminal', d: 'Panel', go: () => onNav('terminal') },
    ]
    const projectItems: PaletteItem[] = recents.map((r) => ({
      kind: 'project',
      icon: 'box',
      t: r.name,
      d: r.source,
      go: () => onNav('proj:' + r.id),
    }))
    const fileItems: PaletteItem[] = openTabs.map((t) => ({
      kind: 'file',
      icon: 'file',
      t: basename(t.path),
      d: t.path,
      go: () => onOpenFile(t.path),
    }))
    return [...actions, ...projectItems, ...fileItems]
  }, [onNav, onOpenFile, recents, openTabs])

  const filtered = useMemo<PaletteItem[]>(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return all
    return all.filter((x) => (x.t + ' ' + x.d).toLowerCase().includes(needle))
  }, [all, q])

  function onKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(filtered.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = filtered[sel]
      if (it) {
        it.go()
        onClose()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const groups: ReadonlyArray<readonly [string, PaletteKind]> = [
    ['Actions', 'action'],
    ['Projects', 'project'],
    ['Files', 'file'],
  ] as const

  // Single running index across all visible rows so keyboard selection and
  // mouse hover share the same coordinate space.
  let runningIdx = -1

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div className="cmd" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-in">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search files, projects, actions…"
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={onKey}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="cmd-list">
          {groups.map(([label, kind]) => {
            const items = filtered.filter((x) => x.kind === kind)
            if (!items.length) return null
            return (
              <div key={label}>
                <div className="cmd-sec">{label}</div>
                {items.map((it) => {
                  runningIdx++
                  const myIdx = runningIdx
                  return (
                    <div
                      key={kind + ':' + it.t + ':' + it.d}
                      className={'cmd-item' + (sel === myIdx ? ' sel' : '')}
                      onMouseEnter={() => setSel(myIdx)}
                      onClick={() => {
                        it.go()
                        onClose()
                      }}
                    >
                      <Icon name={it.icon} />
                      <span className="ci-t">{it.t}</span>
                      <span className="ci-d">{it.d}</span>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {!filtered.length && (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--fg-3)',
                font: 'var(--t-body-sm)',
              }}
            >
              No matches
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
