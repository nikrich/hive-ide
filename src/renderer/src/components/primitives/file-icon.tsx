/**
 * Resolves a filename to either a lucide glyph (built-in themes, or the
 * fallback while a contributed SVG loads) or a contributed SVG (data: URL).
 * Subscribes to the icon-theme store's `version` so tiles upgrade from lucide
 * to SVG as assets resolve.
 */
import { Icon } from './Icon'
import { fileIcon, folderLucide } from './fileIcon'
import { useIconThemeStore, BUILTIN_ICON_THEMES } from '../../store/iconThemeStore'
import { matchIconDef, iconPathFor } from '../../lib/iconThemeDoc'

export interface FileIconProps {
  name: string
  kind: 'file' | 'folder'
  open?: boolean
  size?: number
}

export function FileIcon({ name, kind, open = false, size = 15 }: FileIconProps) {
  const activeId = useIconThemeStore((s) => s.activeId)
  const doc = useIconThemeStore((s) => s.doc)
  // Subscribe to version so a resolved SVG triggers a re-render.
  useIconThemeStore((s) => s.version)
  const svgForDef = useIconThemeStore((s) => s.svgForDef)

  const isBuiltin = (BUILTIN_ICON_THEMES as readonly string[]).includes(activeId)

  if (!isBuiltin && doc !== null) {
    const defId = matchIconDef(doc, name, kind, open)
    const iconPath = iconPathFor(doc, defId)
    const url = defId ? svgForDef(defId, iconPath) : null
    if (url) {
      return (
        <span className='fi fi-svg' style={{ display: 'inline-flex' }}>
          <img src={url} width={size} height={size} alt='' draggable={false} />
        </span>
      )
    }
    // fall through to lucide while the SVG loads / if unmatched
  }

  const [iconName, tint] =
    kind === 'folder' ? folderLucide(open) : fileIcon(name)
  return (
    <span className={'fi ' + tint}>
      <Icon name={iconName} size={size} />
    </span>
  )
}
