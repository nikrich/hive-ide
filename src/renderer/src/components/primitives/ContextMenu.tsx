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
 *
 * The menu + scrim are rendered as CHILDREN of whatever element opened them —
 * typically a clickable row (project row, terminal tab, session row) whose
 * `onClick` opens/selects it. React events bubble along the component tree,
 * so every interactive surface here STOPS propagation: otherwise clicking an
 * item (e.g. "Rename") would also fire the host row's `onClick` and navigate
 * away before the action takes effect. `onMouseDown` is stopped too, since
 * some hosts (terminal panes) act on mousedown rather than click.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 200 }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }}
      />
      <div
        className="menu"
        style={{ position: 'fixed', left: x, top: y, zIndex: 201, minWidth: 160 }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <div
            key={it.label}
            className="menu-item"
            role="button"
            tabIndex={0}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
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
