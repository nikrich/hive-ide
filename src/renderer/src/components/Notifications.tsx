/**
 * Notifications surface (E11-09).
 *
 * Renders the live toast stack (bottom-right) for active notifications, each
 * auto-dismissing after a severity-dependent timeout (errors persist until
 * dismissed). When `centerOpen` is true it also shows a history panel anchored
 * to the title-bar bell, listing every notification with a clear-all action.
 */

import { useEffect } from 'react'

import { Icon } from './primitives'
import {
  useNotificationsStore,
  type Notification,
  type NotificationSeverity,
} from '../store/notificationsStore'

const SEVERITY_ICON: Record<NotificationSeverity, string> = {
  info: 'info',
  warning: 'alert-triangle',
  error: 'x-circle',
}

/** Auto-dismiss delay per severity (ms). Errors never auto-dismiss. */
const AUTO_DISMISS: Record<NotificationSeverity, number | null> = {
  info: 5000,
  warning: 8000,
  error: null,
}

export interface NotificationsProps {
  centerOpen: boolean
  onCloseCenter: () => void
}

export function Notifications({ centerOpen, onCloseCenter }: NotificationsProps) {
  const items = useNotificationsStore((s) => s.items)
  const dismiss = useNotificationsStore((s) => s.dismiss)
  const remove = useNotificationsStore((s) => s.remove)
  const clear = useNotificationsStore((s) => s.clear)

  const active = items.filter((i) => i.active)

  // Schedule auto-dismiss for each active, non-error toast.
  useEffect(() => {
    const timers: number[] = []
    for (const n of active) {
      const delay = AUTO_DISMISS[n.severity]
      if (delay !== null) {
        timers.push(window.setTimeout(() => dismiss(n.id), delay))
      }
    }
    return () => timers.forEach((t) => window.clearTimeout(t))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.map((n) => n.id).join(','), dismiss])

  return (
    <>
      <div className="ntf-stack" role="status" aria-live="polite">
        {active.map((n) => (
          <NotificationToast key={n.id} n={n} onDismiss={() => dismiss(n.id)} />
        ))}
      </div>

      {centerOpen && (
        <>
          <div className="ntf-scrim" onClick={onCloseCenter} />
          <div className="ntf-center" role="dialog" aria-label="Notifications">
            <div className="ntf-center-head">
              <span>Notifications</span>
              <button type="button" className="ntf-clear" onClick={clear}>
                Clear All
              </button>
            </div>
            {items.length === 0 ? (
              <div className="ntf-empty">No notifications.</div>
            ) : (
              [...items]
                .sort((a, b) => b.seq - a.seq)
                .map((n) => (
                  <NotificationRow key={n.id} n={n} onRemove={() => remove(n.id)} />
                ))
            )}
          </div>
        </>
      )}
    </>
  )
}

function NotificationToast({
  n,
  onDismiss,
}: {
  n: Notification
  onDismiss: () => void
}) {
  return (
    <div className={'ntf-toast ' + n.severity}>
      <Icon name={SEVERITY_ICON[n.severity]} size={15} />
      <div className="ntf-body">
        <div className="ntf-msg">{n.message}</div>
        {n.actions && n.actions.length > 0 && (
          <div className="ntf-actions">
            {n.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="ntf-action"
                onClick={() => {
                  a.run()
                  onDismiss()
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="ntf-x"
        title="Dismiss"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}

function NotificationRow({
  n,
  onRemove,
}: {
  n: Notification
  onRemove: () => void
}) {
  return (
    <div className={'ntf-row ' + n.severity}>
      <Icon name={SEVERITY_ICON[n.severity]} size={14} />
      <span className="ntf-row-msg">{n.message}</span>
      <button
        type="button"
        className="ntf-x"
        title="Remove"
        aria-label="Remove notification"
        onClick={onRemove}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

export default Notifications
