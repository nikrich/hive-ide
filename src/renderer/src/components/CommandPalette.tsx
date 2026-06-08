/**
 * Hive IDE — command palette overlay (⌘K / ⌘⇧P).
 *
 * Searches across four groups of targets:
 *   - Commands : everything in the command registry (E6-01), shown with their
 *                keybinding hint (E6-03) and floated by recent use (E6-04)
 *   - Actions  : a few legacy top-level verbs not yet migrated to the registry
 *   - Projects : one entry per recent project → `onNav('proj:<id>')`
 *   - Files    : every open tab, opened via `onOpenFile(path)`
 *
 * Mode prefixes (E6-08):
 *   - `>` → commands only (this is what ⌘⇧P seeds)
 *   - otherwise → mixed (files / projects / actions / commands)
 *
 * Open/close state and the global bindings live in the App shell. This
 * component is the overlay UI: the input auto-focuses, the operator types to
 * filter, Arrow keys + Enter activate, Escape / backdrop-click closes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Icon } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useSettingsStore } from '../store/settingsStore'
import { useCommandStore, visibleCommands } from '../store/commandStore'
import { useKeybindingStore } from '../store/keybindingStore'
import { formatChord } from '../lib/keys'
import { fuzzyFilter } from '../lib/fuzzy'

export interface CommandPaletteProps {
  /** Initial query to seed the input with (e.g. '>' for commands mode). */
  initialQuery?: string
  /** Called when the operator dismisses the palette. */
  onClose: () => void
  /** Top-level navigation hook (see App's `nav`). */
  onNav: (target: string) => void
  /** Called with an absolute file path when a Files row is activated. */
  onOpenFile: (file: string) => void
}

type PaletteKind = 'command' | 'action' | 'project' | 'file'

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

export function CommandPalette({
  initialQuery = '',
  onClose,
  onNav,
  onOpenFile,
}: CommandPaletteProps) {
  const [q, setQ] = useState(initialQuery)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const recents = useWorkspaceStore((s) => s.recents)
  const openTabs = useWorkspaceStore((s) => s.openTabs)
  const repos = useWorkspaceStore((s) => s.repos)
  const activeTabPath = useWorkspaceStore((s) => s.activeTabPath)
  const revealInFile = useWorkspaceStore((s) => s.revealInFile)
  const openInSecondary = useWorkspaceStore((s) => s.openInSecondary)
  const searchExclude = useSettingsStore((s) => s.settings['search.exclude'])

  // Filesystem file index for quick-open (E2-03). Lazily fetched once when the
  // palette opens with a project mounted.
  const [fileIndex, setFileIndex] = useState<string[]>([])
  useEffect(() => {
    const bridge = window.hive?.search
    const roots = repos.map((r) => r.path)
    if (!bridge || roots.length === 0) return
    let cancelled = false
    void bridge
      .listFiles({ roots, exclude: searchExclude, max: 20000 })
      .then((res) => {
        if (!cancelled) setFileIndex(res.files)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commands = useCommandStore((s) => s.commands)
  const context = useCommandStore((s) => s.context)
  const recentCommands = useCommandStore((s) => s.recent)
  const execute = useCommandStore((s) => s.execute)
  const defaultBindings = useKeybindingStore((s) => s.defaults)
  const contributedBindings = useKeybindingStore((s) => s.contributed)
  const userBindings = useKeybindingStore((s) => s.user)
  const allBindings = useMemo(
    () => [...defaultBindings, ...contributedBindings, ...userBindings],
    [defaultBindings, contributedBindings, userBindings],
  )
  const platform = window.hive?.platform ?? 'darwin'

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.setSelectionRange(q.length, q.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Commands mode is on when the query starts with '>'. The hint chord for a
  // command is the first binding pointing at it (E6-03).
  const commandsMode = q.startsWith('>')

  const bindingFor = useMemo(() => {
    const map = new Map<string, string>()
    for (const b of allBindings) {
      if (b.command && !map.has(b.command)) {
        map.set(b.command, formatChord(b.key, platform))
      }
    }
    return map
  }, [allBindings, platform])

  const commandItems = useMemo<PaletteItem[]>(() => {
    const visible = visibleCommands(commands, context)
    // Float recently-used commands to the top, preserving registry order
    // for the rest.
    const rank = new Map(recentCommands.map((id, i) => [id, i]))
    visible.sort((a, b) => {
      const ra = rank.has(a.id) ? (rank.get(a.id) as number) : Infinity
      const rb = rank.has(b.id) ? (rank.get(b.id) as number) : Infinity
      if (ra !== rb) return ra - rb
      return 0
    })
    return visible.map((c) => ({
      kind: 'command' as const,
      icon: 'chevron-right',
      t: c.category ? `${c.category}: ${c.title}` : c.title,
      d: bindingFor.get(c.id) ?? '',
      go: () => execute(c.id),
    }))
  }, [commands, context, recentCommands, bindingFor, execute])

  // Go-to-line mode (E2-08): `:42` jumps to line 42 in the active editor.
  const gotoLineMode = q.startsWith(':')
  const gotoLine = gotoLineMode ? parseInt(q.slice(1).trim(), 10) : NaN

  const projectItems = useMemo<PaletteItem[]>(
    () =>
      recents.map((r) => ({
        kind: 'project',
        icon: 'box',
        t: r.name,
        d: `${r.repoCount} repo${r.repoCount === 1 ? '' : 's'}`,
        go: () => onNav('proj:' + r.id),
      })),
    [recents, onNav],
  )

  const filtered = useMemo<PaletteItem[]>(() => {
    if (gotoLineMode) return []
    if (commandsMode) {
      const needle = q.slice(1).trim().toLowerCase()
      if (!needle) return commandItems
      return commandItems.filter((x) =>
        (x.t + ' ' + x.d).toLowerCase().includes(needle),
      )
    }

    const needle = q.trim()
    const lower = needle.toLowerCase()

    // Files: fuzzy over the whole filesystem index when we have one; fall back
    // to open tabs (so the palette still works before the index loads / with
    // no project).
    const fileSource =
      fileIndex.length > 0
        ? fileIndex
        : openTabs.filter((t) => !t.path.startsWith('diff:')).map((t) => t.path)
    const rankedFiles = (needle ? fuzzyFilter(needle, fileSource, (p) => p) : fileSource)
      .slice(0, 100)
      .map<PaletteItem>((path) => ({
        kind: 'file',
        icon: 'file',
        t: basename(path),
        d: path,
        go: () => onOpenFile(path),
      }))

    if (!needle) {
      return [...commandItems, ...projectItems, ...rankedFiles]
    }
    const cmds = commandItems.filter((x) =>
      (x.t + ' ' + x.d).toLowerCase().includes(lower),
    )
    const projs = projectItems.filter((x) =>
      (x.t + ' ' + x.d).toLowerCase().includes(lower),
    )
    return [...cmds, ...projs, ...rankedFiles]
  }, [
    commandsMode,
    gotoLineMode,
    q,
    commandItems,
    projectItems,
    fileIndex,
    openTabs,
    onOpenFile,
  ])

  function activateGotoLine(): void {
    if (!Number.isFinite(gotoLine) || gotoLine < 1) return
    if (activeTabPath && !activeTabPath.startsWith('diff:')) {
      revealInFile(activeTabPath, gotoLine)
    }
    onClose()
  }

  function onKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(filtered.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (gotoLineMode) {
        activateGotoLine()
        return
      }
      const it = filtered[sel]
      if (it) {
        // ⌘/Ctrl+Enter opens a file result to the side (E5-02).
        if ((e.metaKey || e.ctrlKey) && it.kind === 'file') {
          openInSecondary(it.d)
        } else {
          it.go()
        }
        onClose()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const groups: ReadonlyArray<readonly [string, PaletteKind]> = commandsMode
    ? ([['Commands', 'command']] as const)
    : ([
        ['Commands', 'command'],
        ['Projects', 'project'],
        ['Files', 'file'],
      ] as const)

  let runningIdx = -1

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div className="cmd" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-in">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={q}
            placeholder={
              commandsMode
                ? 'Type a command…'
                : 'Search files…  › commands  : go to line'
            }
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={onKey}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="cmd-list">
          {gotoLineMode && (
            <div className="cmd-sec">
              {Number.isFinite(gotoLine) && gotoLine >= 1
                ? `Go to line ${gotoLine} — press Enter`
                : 'Type a line number'}
            </div>
          )}
          {!gotoLineMode &&
            groups.map(([label, kind]) => {
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
