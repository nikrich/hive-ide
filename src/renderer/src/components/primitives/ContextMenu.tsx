export interface ContextMenuItem {
  label: string
  onSelect: () => void
}

export interface ContextMenuProps {
  /** Viewport x of the click that opened the menu. */
  x: number
  /** Viewport y of the click that opened the menu. */
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/**
 * A cursor-anchored popup menu. Reuses the existing `.menu` / `.menu-item`
 * styling. Renders a fixed full-viewport scrim behind the menu so any
 * outside click dismisses it.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 200 }}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="menu"
        style={{ position: 'fixed', left: x, top: y, zIndex: 201, minWidth: 160 }}
      >
        {items.map((it) => (
          <div
            key={it.label}
            className="menu-item"
            role="button"
            tabIndex={0}
            onClick={() => {
              it.onSelect()
              onClose()
            }}
          >
            <div className="mi-meta">
              <div className="mi-n">{it.label}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
