import { ROLE, type RoleKey } from '../../data/seed'
import { hexA } from './hexA'

export interface RoleAvaProps {
  role: RoleKey
  /** Diameter in px. Defaults to 28 to match the design reference. */
  size?: number
  /** When true, render the live-status dot (uses `--status-running`). */
  live?: boolean
  /** Override status-dot colour. Implies the dot is rendered. */
  dot?: string
}

export function RoleAva({ role, size = 28, live, dot }: RoleAvaProps) {
  const r = ROLE[role]
  const dotSize = Math.max(8, Math.round(size * 0.34))
  const showDot = live === true || dot !== undefined

  return (
    <span
      className="ava"
      title={r.label}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        color: r.color,
        background: hexA(r.color, 0.16),
        borderColor: hexA(r.color, 0.42),
      }}
    >
      {r.abbr}
      {showDot && (
        <span
          className="sdot"
          style={{
            width: dotSize,
            height: dotSize,
            background: dot ?? 'var(--status-running)',
          }}
        />
      )}
    </span>
  )
}
