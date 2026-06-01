import { Pulse } from './Pulse'

export type StatusKey =
  | 'running'
  | 'pending'
  | 'review'
  | 'blocked'
  | 'merged'
  | 'done'
  | 'idle'

interface StatusMeta {
  cls: string
  label: string
  pulse: boolean
}

const STATUS: Record<StatusKey, StatusMeta> = {
  running: { cls: 'st-running', label: 'running', pulse: true },
  pending: { cls: 'st-pending', label: 'pending', pulse: false },
  review: { cls: 'st-review', label: 'in review', pulse: false },
  blocked: { cls: 'st-blocked', label: 'blocked', pulse: false },
  merged: { cls: 'st-merged', label: 'merged', pulse: false },
  done: { cls: 'st-done', label: 'done', pulse: false },
  idle: { cls: 'st-idle', label: 'idle', pulse: false },
}

export interface StatusChipProps {
  status: StatusKey
  /** Optional label override; falls back to the canonical label for `status`. */
  label?: string
}

export function StatusChip({ status, label }: StatusChipProps) {
  const meta = STATUS[status]
  return (
    <span className={`chip ${meta.cls}`}>
      {meta.pulse ? (
        <Pulse />
      ) : (
        <span className="dot" style={{ background: 'currentColor' }} />
      )}
      {label ?? meta.label}
    </span>
  )
}
