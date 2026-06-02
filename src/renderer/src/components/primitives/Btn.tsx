import type { CSSProperties, MouseEventHandler, ReactNode } from 'react'
import { Icon } from './Icon'

export type BtnKind = 'primary' | 'cta' | 'amber' | 'outline' | 'ghost'

export interface BtnProps {
  kind: BtnKind
  /** Compact variant — adds `btn-sm`. */
  sm?: boolean
  /** Optional leading kebab-case lucide icon name. */
  icon?: string
  children?: ReactNode
  onClick?: MouseEventHandler<HTMLButtonElement>
  style?: CSSProperties
  /** Disabled state — visually dimmed + ignores clicks. */
  disabled?: boolean
}

export function Btn({ kind, sm, icon, children, onClick, style, disabled }: BtnProps) {
  const className = `btn btn-${kind}${sm ? ' btn-sm' : ''}`
  return (
    <button
      className={className}
      onClick={onClick}
      style={style}
      type="button"
      disabled={disabled}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  )
}
