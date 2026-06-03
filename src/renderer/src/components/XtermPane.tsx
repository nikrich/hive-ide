/**
 * XtermPane — a single self-contained node-pty/xterm.js terminal.
 *
 * Extracted so the full-screen Warp-style {@link TerminalView} can compose
 * many of these into a split-pane tree, each pane being a *real* shell (not a
 * mock transcript). The proven lifecycle is the same one the bottom-panel
 * {@link TerminalPanel} uses: spawn once on mount, wire pty ⇄ xterm, debounce
 * a `ResizeObserver` driving `fit.fit()` + `terminal:resize`, dispose on
 * unmount.
 *
 * Visibility: the pane is kept mounted even when its session is hidden
 * (the ancestor flips `display:none`). The `ResizeObserver` fires when the
 * host transitions 0→size on re-show, so `fit()` re-measures automatically —
 * no explicit "active" plumbing needed for sizing. The `focused` prop only
 * drives `xterm.focus()` so the active pane of the active session takes the
 * keyboard.
 *
 * `cwd` is captured at spawn time; changing it later does NOT respawn the
 * shell (the running shell is the user's working state).
 */

import { useEffect, useRef } from 'react'

import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import {
  FONT_FAMILY,
  FONT_SIZE,
  LINE_HEIGHT,
  RESIZE_DEBOUNCE_MS,
  TERMINAL_THEME,
} from './Terminal'

export interface XtermPaneProps {
  /** Working directory for the spawned shell. Falls back to home in main. */
  cwd: string | undefined
  /** When true, this pane owns the keyboard — focus the xterm. */
  focused: boolean
  /** Called when the pty exits so the parent can mark the pane dead. */
  onExit?: () => void
}

export function XtermPane({ cwd, focused, onExit }: XtermPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  // Imperative resources we own across renders.
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const unsubDataRef = useRef<(() => void) | null>(null)
  const unsubExitRef = useRef<(() => void) | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resizeObsRef = useRef<ResizeObserver | null>(null)

  // Capture cwd so the spawn effect (empty deps) doesn't go stale, but never
  // change cwd for an already-running pty.
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  // Keep the latest onExit without re-running the spawn effect.
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  // Mirror `focused` into a ref so the spawn effect can read it on first
  // paint (and the focus effect below flips it imperatively afterwards).
  const focusedRef = useRef(focused)
  focusedRef.current = focused

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

    // First fit before asking main for dims. If hidden (display:none) at
    // mount, fit() may report a 0-row terminal — guard with defaults.
    try {
      fit.fit()
    } catch {
      // Hidden / 0-px host. We re-fit via the ResizeObserver on show.
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
          await window.hive.terminal.dispose(res.id).catch(() => undefined)
          return
        }
        ptyIdRef.current = res.id

        unsubDataRef.current = window.hive.terminal.onData(res.id, (data) => {
          xterm.write(data)
        })
        unsubExitRef.current = window.hive.terminal.onExit(res.id, () => {
          xterm.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
          onExitRef.current?.()
        })
        xterm.onData((data) => {
          const id = ptyIdRef.current
          if (id) void window.hive.terminal.write(id, data)
        })

        if (focusedRef.current) xterm.focus()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('terminal:spawn failed', err)
        xterm.write(
          `\r\n\x1b[31mFailed to start terminal: ${String(err)}\x1b[0m\r\n`,
        )
      }
    })()

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
          // Host removed mid-debounce — swallow.
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
      if (id) void window.hive.terminal.dispose(id).catch(() => undefined)
      try {
        xterm.dispose()
      } catch {
        // dispose is idempotent in practice; swallow defensively.
      }
      xtermRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -------------------- focus when this pane is active -------------------
  useEffect(() => {
    if (!focused) return
    const xterm = xtermRef.current
    const fit = fitRef.current
    if (!xterm || !fit) return
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
  }, [focused])

  return <div ref={hostRef} className="cc-xterm" />
}

export default XtermPane
