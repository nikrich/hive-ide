import type { CSSProperties } from 'react'
import * as LucideIcons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Public name → lucide-react component-name aliases.
 *
 * The design-reference (`primitives.jsx`) uses kebab-case names that don't
 * always survive a simple kebab→PascalCase conversion (lucide v0 → v1 rename).
 * Anything in this map wins over the auto-converted name.
 */
const ALIASES: Record<string, string> = {
  'alert-triangle': 'TriangleAlert',
  'check-circle-2': 'CircleCheckBig',
  'x-circle': 'CircleX',
}

function toPascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('')
}

/**
 * Index lucide-react's namespace by string. The package exports every icon
 * as a PascalCase named export; this cast is the (typed) bridge between our
 * runtime string name and that static export shape.
 */
const ICON_NAMESPACE = LucideIcons as unknown as Record<string, LucideIcon | undefined>

export interface IconProps {
  /** kebab-case lucide icon name, e.g. `'git-branch'`. */
  name: string
  size?: number
  style?: CSSProperties
  className?: string
}

export function Icon({ name, size = 16, style, className }: IconProps) {
  const componentName = ALIASES[name] ?? toPascalCase(name)
  const LucideComponent = ICON_NAMESPACE[componentName]

  if (!LucideComponent) {
    // Unknown icon — render a sized placeholder so layouts don't shift.
    return (
      <span
        aria-hidden
        className={className}
        style={{ display: 'inline-flex', width: size, height: size, ...style }}
      />
    )
  }

  return <LucideComponent size={size} style={style} className={className} />
}
