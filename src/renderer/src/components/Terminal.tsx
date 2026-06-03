/**
 * Multi-tab terminal panel — REQ-004.
 *
 * Replaces the prototype's faux-shell `<Terminal />` in `BottomPanel.tsx`
 * with a real xterm.js front-end driven by node-pty in the main process
 * (`src/main/terminal/handlers.ts`).
 *
 * UX shape:
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ [Term 1]  [Term 2]  [Term 3]   [+]                        │  <- .term-tabs
 *   ├───────────────────────────────────────────────────────────┤
 *   │                                                           │
 *   │   <active xterm canvas>                                   │  <- .term-host
 *   │                                                           │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Implementation choices:
 *
 *   - One `Terminal` xterm instance per tab, kept mounted, hidden with
 *     `display: none` when not active. Recreating the instance on every
 *     tab switch would lose scrollback and force a fresh
 *     `terminal:spawn` round-trip (the pty is independent of the xterm).
 *
 *   - Resize is debounced 100ms inside a single `ResizeObserver` on the
 *     host. Without debounce, dragging the bottom panel handle floods
 *     the IPC channel — node-pty's `resize()` is cheap but `fit.fit()`
 *     re-measures the DOM and the cumulative cost is noticeable.
 *
 *   - On unmount of the panel, every pty + xterm is disposed. There's
 *     no "background terminal" model in this REQ.
 *
 *   - cwd for a newly-spawned tab is the active project's first repo's
 *     path; if no project or no repos, `undefined` is passed and main
 *     falls back to `os.homedir()`.
 *
 * Theme colours come from `src/renderer/src/styles/tokens.css` (read at
 * module-init time as a static hex map). xterm needs hex strings up
 * front, not CSS variables, so we don't try to be clever with
 * `getComputedStyle` per-instance.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import { Icon } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'

// ---------------------------------------------------------------------------
// Theme + font
// ---------------------------------------------------------------------------

/**
 * Theme matched to `--bg-inset` (`#060A14`) and the slate palette in
 * tokens.css. Bright/dim ANSI variants picked from common terminal
 * defaults — feels right against the navy shell without an explicit
 * design pass.
 */
export const TERMINAL_THEME: ITheme = {
  background: '#060A14', // --bg-inset
  foreground: '#F1F5F9', // --fg-1
  cursor: '#F59E0B', // --hive-amber
  cursorAccent: '#060A14',
  selectionBackground: 'rgba(99, 102, 241, 0.35)', // --indigo-700 @ 35%
  black: '#0F172A',
  red: '#FB7185', // --diff-del-fg
  green: '#4ADE80', // --diff-add-fg
  yellow: '#FBBF24', // --amber-400
  blue: '#60A5FA',
  magenta: '#A876FF', // --indigo-400
  cyan: '#22D3EE', // --role-junior
  white: '#E2E8F0', // --slate-200
  brightBlack: '#475569', // --slate-600
  brightRed: '#F43F5E',
  brightGreen: '#10B981', // --status-done
  brightYellow: '#F59E0B', // --hive-amber
  brightBlue: '#3B82F6',
  brightMagenta: '#8B5CF6',
  brightCyan: '#14B8A6', // --status-running
  brightWhite: '#F1F5F9',
}

export const FONT_FAMILY = "'JetBrains Mono', ui-monospace, Menlo, monospace"
export const FONT_SIZE = 13
export const LINE_HEIGHT = 1.4

export const RESIZE_DEBOUNCE_MS = 100

// ---------------------------------------------------------------------------
// Tab model
// ---------------------------------------------------------------------------

/** UI-side tab record. The pty `id` is set after the spawn round-trip lands. */
interface TabEntry {
  /** Stable per-mount id used for React keys + xterm ownership. */
  tabId: string
  /** Display label ("Term 1", "Term 2", …). */
  title: string
  /**
   * The pty `id` returned by `terminal:spawn`. Null until the spawn
   * promise resolves and also null after the pty exits.
   */
  ptyId: string | null
  /** Set when the pty has exited so the tab strip can show a dim state. */
  exited: boolean
}

let nextTabSeq = 1
function newTabEntry(): TabEntry {
  return {
    tabId: `tab-${Date.now()}-${nextTabSeq}`,
    title: `Term ${nextTabSeq++}`,
    ptyId: null,
    exited: false,
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function TerminalPanel() {
  const project = useWorkspaceStore((s) => s.project)

  // First repo's path as the cwd seed. Recomputed per spawn so opening a
  // new tab after the user adds a repo picks up the new path.
  const cwd = useMemo(
    () => project?.repos[0]?.path,
    [project?.repos],
  )

  const [tabs, setTabs] = useState<TabEntry[]>(() => [newTabEntry()])
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].tabId)

  // Track the active id by ref too — used inside the close handler so we
  // can decide what to focus next without subscribing to a stale value.
  const activeIdRef = useRef(activeTabId)
  useEffect(() => {
    activeIdRef.current = activeTabId
  }, [activeTabId])

  const openTab = (): void => {
    const entry = newTabEntry()
    setTabs((prev) => [...prev, entry])
    setActiveTabId(entry.tabId)
  }

  const closeTab = (tabId: string): void => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.tabId === tabId)
      if (idx === -1) return prev
      const next = prev.filter((t) => t.tabId !== tabId)

      // Focus the previous tab (or next-leftmost) if we just closed the
      // active one. Empty strip is allowed — the `+` button still works.
      if (activeIdRef.current === tabId) {
        const fallback = next[idx - 1] ?? next[idx] ?? null
        setActiveTabId(fallback ? fallback.tabId : '')
      }
      return next
    })
  }

  // Auto-spawn one tab on first mount if the user landed here with none.
  // The default state already seeds one, so this only fires after a user
  // closes every tab and re-opens the panel later.
  useEffect(() => {
    if (tabs.length === 0) {
      const entry = newTabEntry()
      setTabs([entry])
      setActiveTabId(entry.tabId)
    }
  }, [tabs.length])

  return (
    <div className="term-panel">
      <div className="term-tabs" role="tablist">
        {tabs.map((t) => (
          <TermTabChip
            key={t.tabId}
            entry={t}
            active={t.tabId === activeTabId}
            onSelect={() => setActiveTabId(t.tabId)}
            onClose={() => closeTab(t.tabId)}
          />
        ))}
        <button
          type="button"
          className="term-tab-add"
          title="New terminal"
          onClick={openTab}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="term-host">
        {tabs.map((t) => (
          <TerminalInstance
            key={t.tabId}
            entry={t}
            active={t.tabId === activeTabId}
            cwd={cwd}
            onExit={() => {
              setTabs((prev) =>
                prev.map((p) =>
                  p.tabId === t.tabId ? { ...p, exited: true } : p,
                ),
              )
            }}
            onPtyId={(id) => {
              setTabs((prev) =>
                prev.map((p) => (p.tabId === t.tabId ? { ...p, ptyId: id } : p)),
              )
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab chip
// ---------------------------------------------------------------------------

interface TermTabChipProps {
  entry: TabEntry
  active: boolean
  onSelect: () => void
  onClose: () => void
}

function TermTabChip({ entry, active, onSelect, onClose }: TermTabChipProps) {
  return (
    <div
      className={
        'term-tab' +
        (active ? ' active' : '') +
        (entry.exited ? ' exited' : '')
      }
      role="tab"
      aria-selected={active}
      onClick={onSelect}
    >
      <span className="term-tab-label">{entry.title}</span>
      <button
        type="button"
        className="term-tab-close"
        title="Close terminal"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-tab xterm + pty wiring
// ---------------------------------------------------------------------------

interface TerminalInstanceProps {
  entry: TabEntry
  active: boolean
  cwd: string | undefined
  onPtyId: (id: string) => void
  onExit: () => void
}

/**
 * One xterm instance + one pty, kept mounted for the lifetime of the
 * tab. Visibility flips via inline `display` so scrollback / cursor /
 * selection survive a tab switch.
 *
 * The component spawns its pty exactly once on mount, regardless of how
 * many times it re-renders. `cwd` is captured at spawn time — switching
 * projects mid-session does NOT respawn an open terminal (that would
 * surprise the user; the running shell is the user's working state).
 */
function TerminalInstance({
  entry,
  active,
  cwd,
  onPtyId,
  onExit,
}: TerminalInstanceProps) {
  // The DOM node xterm renders into.
  const hostRef = useRef<HTMLDivElement | null>(null)

  // Imperative handles kept across renders. Stored in refs because they
  // are mutable resources we own, not React state.
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const unsubDataRef = useRef<(() => void) | null>(null)
  const unsubExitRef = useRef<(() => void) | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resizeObsRef = useRef<ResizeObserver | null>(null)

  // Capture cwd in a ref so the spawn effect (which has an empty deps
  // array) doesn't go stale — but never change cwd for an existing pty.
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  // -------------------- mount / unmount ---------------------------------

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let cancelled = false

    const xterm = new XTerm({
      theme: TERMINAL_THEME,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: false,
      convertEol: false,
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(host)
    xtermRef.current = xterm
    fitRef.current = fit

    // First fit before we ask main for dims. If the panel is hidden
    // (display:none) at mount, fit() may report a 0-row terminal — guard
    // with sensible defaults so the spawn at least gets `80x24`.
    try {
      fit.fit()
    } catch {
      // Hidden / 0-px host. We'll fit again when the tab is shown.
    }
    const cols = Math.max(1, xterm.cols || 80)
    const rows = Math.max(1, xterm.rows || 24)

    void (async () => {
      try {
        const res = await window.hive.terminal.spawn({
          cwd: cwdRef.current,
          cols,
          rows,
        })
        if (cancelled) {
          // Component unmounted between the request and the response.
          // Dispose the pty so we don't leak.
          await window.hive.terminal.dispose(res.id).catch(() => undefined)
          return
        }
        ptyIdRef.current = res.id
        onPtyId(res.id)

        // Wire pty <-> xterm.
        unsubDataRef.current = window.hive.terminal.onData(res.id, (data) => {
          xterm.write(data)
        })
        unsubExitRef.current = window.hive.terminal.onExit(res.id, () => {
          onExit()
        })
        xterm.onData((data) => {
          const id = ptyIdRef.current
          if (id) void window.hive.terminal.write(id, data)
        })
      } catch (err) {
        // Surface the failure inside the terminal canvas — it's the only
        // dedicated UI surface we have. Console too so a dev sees it.
        // eslint-disable-next-line no-console
        console.error('terminal:spawn failed', err)
        xterm.write(
          `\r\n\x1b[31mFailed to start terminal: ${String(err)}\x1b[0m\r\n`,
        )
      }
    })()

    // Resize observer — debounced. Fires on panel drag, window resize,
    // and tab-switch (because flipping display from none → block
    // changes the host's measured size).
    const ro = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        try {
          fit.fit()
          const id = ptyIdRef.current
          if (id) {
            void window.hive.terminal.resize(id, xterm.cols, xterm.rows)
          }
        } catch {
          // Host might have been removed mid-debounce — swallow.
        }
      }, RESIZE_DEBOUNCE_MS)
    })
    ro.observe(host)
    resizeObsRef.current = ro

    return () => {
      cancelled = true
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
      resizeObsRef.current?.disconnect()
      resizeObsRef.current = null
      unsubDataRef.current?.()
      unsubDataRef.current = null
      unsubExitRef.current?.()
      unsubExitRef.current = null
      const id = ptyIdRef.current
      ptyIdRef.current = null
      if (id) {
        void window.hive.terminal.dispose(id).catch(() => undefined)
      }
      try {
        xterm.dispose()
      } catch {
        // xterm.dispose is idempotent in practice; swallow defensively.
      }
      xtermRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.tabId])

  // -------------------- active-tab fit + focus --------------------------

  useEffect(() => {
    if (!active) return
    const xterm = xtermRef.current
    const fit = fitRef.current
    if (!xterm || !fit) return

    // When a tab becomes visible we have to re-measure: while hidden
    // (display:none) the host is 0×0 and the previous fit() captured a
    // useless size.
    const t = setTimeout(() => {
      try {
        fit.fit()
        const id = ptyIdRef.current
        if (id) void window.hive.terminal.resize(id, xterm.cols, xterm.rows)
        xterm.focus()
      } catch {
        // Best-effort.
      }
    }, 0)
    return () => clearTimeout(t)
  }, [active])

  return (
    <div
      ref={hostRef}
      className="term-instance"
      style={{ display: active ? 'block' : 'none' }}
    />
  )
}
