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
import { useCommandStore, visibleCommands } from '../store/commandStore'
import { useKeybindingStore } from '../store/keybindingStore'
import { formatChord } from '../lib/keys'

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

  const commands = useCommandStore((s) => s.commands)
  const context = useCommandStore((s) => s.context)
  const recentCommands = useCommandStore((s) => s.recent)
  const execute = useCommandStore((s) => s.execute)
  const defaultBindings = useKeybindingStore((s) => s.defaults)
  const userBindings = useKeybindingStore((s) => s.user)
  const allBindings = useMemo(
    () => [...defaultBindings, ...userBindings],
    [defaultBindings, userBindings],
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

  const all = useMemo<PaletteItem[]>(() => {
    const projectItems: PaletteItem[] = recents.map((r) => ({
      kind: 'project',
      icon: 'box',
      t: r.name,
      d: `${r.repoCount} repo${r.repoCount === 1 ? '' : 's'}`,
      go: () => onNav('proj:' + r.id),
    }))
    const fileItems: PaletteItem[] = openTabs
      .filter((t) => !t.path.startsWith('diff:'))
      .map((t) => ({
        kind: 'file',
        icon: 'file',
        t: basename(t.path),
        d: t.path,
        go: () => onOpenFile(t.path),
      }))
    return [...commandItems, ...projectItems, ...fileItems]
  }, [commandItems, onNav, onOpenFile, recents, openTabs])

  const filtered = useMemo<PaletteItem[]>(() => {
    if (commandsMode) {
      const needle = q.slice(1).trim().toLowerCase()
      const cmds = commandItems
      if (!needle) return cmds
      return cmds.filter((x) => (x.t + ' ' + x.d).toLowerCase().includes(needle))
    }
    const needle = q.trim().toLowerCase()
    if (!needle) return all
    return all.filter((x) => (x.t + ' ' + x.d).toLowerCase().includes(needle))
  }, [all, commandItems, commandsMode, q])

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
                : 'Search files, projects, commands…  (› for commands)'
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
