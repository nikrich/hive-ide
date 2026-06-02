/**
 * Hive IDE — transient toast (STORY-026).
 *
 * A tiny corner notification with no dependencies on a toast library —
 * we're showing one of these at most for the external-delete case. The
 * `Editor` keeps the toast model in component state; when it's non-null
 * this component renders and self-dismisses after `durationMs`.
 *
 * Styled via `.toast` in `ide.css` using the existing token palette
 * (`--bg-elevated`, `--fg-1`, `--border-default`).
 */
import { useEffect } from 'react'

export interface ToastProps {
  /** Message text. Plain string — no markdown, no HTML. */
  message: string
  /** Milliseconds to auto-dismiss after. Defaults to 4 000. */
  durationMs?: number
  /** Called when the toast self-dismisses or is closed by the user. */
  onDismiss: () => void
}

export function Toast({ message, durationMs = 4000, onDismiss }: ToastProps) {
  // Schedule auto-dismiss. Re-runs when `message` changes (a new toast
  // replaces the running timer instead of stacking).
  useEffect(() => {
    const handle = window.setTimeout(onDismiss, durationMs)
    return () => window.clearTimeout(handle)
  }, [message, durationMs, onDismiss])

  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast-msg">{message}</span>
      <button
        type="button"
        className="toast-x"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  )
}

export default Toast
