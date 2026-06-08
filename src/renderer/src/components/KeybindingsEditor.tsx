/**
 * Keybindings editor (E4-04) — also the shortcut reference (E12-07).
 *
 * Lists every registered command with its effective chord, searchable. The user
 * can rebind a command (press a chord, captured live), reset a customised
 * binding, or unbind it. Conflicts (one chord → multiple commands) are flagged.
 * The user layer persists to localStorage and overrides defaults/contributed.
 */

import { useEffect, useMemo, useState } from 'react'

import { Icon } from './primitives'
import { useCommandStore, type Command } from '../store/commandStore'
import { useKeybindingStore, type Keybinding } from '../store/keybindingStore'
import { chordFromEvent, formatChord } from '../lib/keys'
import { saveUserKeybindings } from '../lib/keybindingsPersistence'

export interface KeybindingsEditorProps {
  onClose?: () => void
}

export function KeybindingsEditor({ onClose }: KeybindingsEditorProps) {
  const commands = useCommandStore((s) => s.commands)
  const defaults = useKeybindingStore((s) => s.defaults)
  const contributed = useKeybindingStore((s) => s.contributed)
  const user = useKeybindingStore((s) => s.user)
  const setUser = useKeybindingStore((s) => s.setUser)
  const platform = window.hive?.platform ?? 'darwin'

  const [query, setQuery] = useState('')
  const [capturing, setCapturing] = useState<string | null>(null)

  // Effective binding per command (user > contributed > default).
  const effective = useMemo(() => {
    const map = new Map<string, Keybinding>()
    for (const b of [...defaults, ...contributed, ...user]) {
      if (b.command) map.set(b.command, b)
    }
    return map
  }, [defaults, contributed, user])

  // Chord → commands, to flag conflicts.
  const chordUse = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const b of effective.values()) {
      if (!m.has(b.key)) m.set(b.key, new Set())
      m.get(b.key)?.add(b.command)
    }
    return m
  }, [effective])

  const rows = useMemo<Command[]>(() => {
    const needle = query.trim().toLowerCase()
    const list = Object.values(commands).sort((a, b) =>
      (a.category ?? '').localeCompare(b.category ?? '') ||
      a.title.localeCompare(b.title),
    )
    if (!needle) return list
    return list.filter((c) => {
      const chord = effective.get(c.id)?.key ?? ''
      return (
        (c.title + ' ' + (c.category ?? '') + ' ' + c.id + ' ' + chord)
          .toLowerCase()
          .includes(needle)
      )
    })
  }, [commands, query, effective])

  // Capture a chord while rebinding.
  useEffect(() => {
    if (capturing === null) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      const chord = chordFromEvent(e, platform)
      if (chord === null) return // lone modifier
      const next = [
        ...user.filter((b) => b.command !== capturing),
        { key: chord, command: capturing, source: 'user' as const },
      ]
      setUser(next)
      saveUserKeybindings(next)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, platform, user, setUser])

  const resetBinding = (commandId: string): void => {
    const next = user.filter((b) => b.command !== commandId)
    setUser(next)
    saveUserKeybindings(next)
  }

  const isCustom = (commandId: string): boolean =>
    user.some((b) => b.command === commandId)

  return (
    <div className="wsview">
      <div className="ws-toolbar">
        {onClose && (
          <button
            type="button"
            className="set-jsonbtn"
            title="Close"
            aria-label="Close keybindings"
            onClick={onClose}
          >
            <Icon name="arrow-left" size={13} />
          </button>
        )}
        <div className="ws-title">
          <Icon name="keyboard" size={15} /> Keyboard Shortcuts
        </div>
        <div className="set-search">
          <Icon name="search" size={13} />
          <input
            value={query}
            placeholder="Search shortcuts"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search shortcuts"
          />
        </div>
      </div>

      <div className="kb-list">
        <div className="kb-row kb-head">
          <span>Command</span>
          <span>Keybinding</span>
          <span>When</span>
          <span />
        </div>
        {rows.map((c) => {
          const binding = effective.get(c.id)
          const chord = binding?.key
          const conflict = chord ? (chordUse.get(chord)?.size ?? 0) > 1 : false
          return (
            <div key={c.id} className="kb-row">
              <span className="kb-cmd">
                {c.category ? `${c.category}: ` : ''}
                {c.title}
              </span>
              <span className="kb-chord">
                {capturing === c.id ? (
                  <em>Press desired key… (Esc to cancel)</em>
                ) : chord ? (
                  <kbd className={conflict ? 'kb-conflict' : undefined}>
                    {formatChord(chord, platform)}
                  </kbd>
                ) : (
                  <span className="kb-unbound">—</span>
                )}
              </span>
              <span className="kb-when">{binding?.when ?? ''}</span>
              <span className="kb-actions">
                <button
                  type="button"
                  className="kb-btn"
                  title="Change keybinding"
                  onClick={() => setCapturing(c.id)}
                >
                  <Icon name="pencil" size={12} />
                </button>
                {isCustom(c.id) && (
                  <button
                    type="button"
                    className="kb-btn"
                    title="Reset to default"
                    onClick={() => resetBinding(c.id)}
                  >
                    <Icon name="rotate-ccw" size={12} />
                  </button>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default KeybindingsEditor
