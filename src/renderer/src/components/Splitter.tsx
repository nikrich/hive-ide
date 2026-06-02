/**
 * Hive IDE — Splitter (REQ-005).
 *
 * Thin draggable bar that sits between two IDE panels and emits pointer
 * deltas to its parent. Deliberately dumb: clamping (min/max) is the
 * parent's job — the splitter just reports "the user moved N pixels".
 *
 * Behaviour:
 *
 *   - Mouse / touch / pen via `PointerEvent`.
 *   - On pointer-down the component calls `setPointerCapture` so a
 *     mouse-up that lands outside the bar still releases the drag (the
 *     classic "lost the cursor while dragging" hazard).
 *   - During a drag the body gets `user-select: none` and a forced
 *     resize cursor via a `.ide.dragging` body class so quick mouse
 *     movements don't show a text-cursor over child elements and
 *     don't accidentally select text.
 *
 * Rendering:
 *
 *   - 1px visible line, ~7px hit area via a `::before` pseudo-element
 *     defined in `styles/ide.css` (see the `.splitter` block).
 *   - `dragging` class is applied while a drag is active so the line
 *     tints to `var(--accent)` for feedback.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface SplitterProps {
  /**
   * `vertical`   = a vertical bar between two columns; drag horizontally.
   *                Emits positive deltas when the pointer moves right.
   * `horizontal` = a horizontal bar between two rows; drag vertically.
   *                Emits positive deltas when the pointer moves down.
   */
  orientation: 'vertical' | 'horizontal'

  /**
   * Called on every `pointermove` while the pointer is captured. `deltaPx`
   * is the delta from the previous emit (not from drag-start) so the parent
   * can do `next = clamp(current + d, min, max)` without bookkeeping.
   */
  onDrag: (deltaPx: number) => void

  /** Optional ARIA label for screen readers. */
  ariaLabel?: string

  /**
   * Optional extra class — used by the IDE to pin the splitter to a named
   * grid area (e.g. `'explorer-splitter'`). Appended after the built-in
   * `splitter <orientation>` / `dragging` classes.
   */
  className?: string
}

/** Body class applied while a drag is active. Drives global cursor + select. */
const DRAGGING_CLASS = 'ide-dragging'

export function Splitter({
  orientation,
  onDrag,
  ariaLabel,
  className,
}: SplitterProps) {
  const [dragging, setDragging] = useState(false)
  const lastRef = useRef<number | null>(null)

  // Tear the dragging body class off on unmount in case the component is
  // dropped mid-drag (e.g. dock collapses while the user is dragging).
  useEffect(() => {
    return () => {
      document.body.classList.remove(DRAGGING_CLASS)
      document.body.classList.remove(`${DRAGGING_CLASS}-${orientation}`)
    }
  }, [orientation])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const el = event.currentTarget
      try {
        el.setPointerCapture(event.pointerId)
      } catch {
        // setPointerCapture can throw if the pointer id is already
        // captured elsewhere — non-fatal, we still track deltas via
        // the subsequent pointermove events.
      }
      lastRef.current =
        orientation === 'vertical' ? event.clientX : event.clientY
      setDragging(true)
      document.body.classList.add(DRAGGING_CLASS)
      document.body.classList.add(`${DRAGGING_CLASS}-${orientation}`)
    },
    [orientation],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (lastRef.current === null) return
      const next =
        orientation === 'vertical' ? event.clientX : event.clientY
      const delta = next - lastRef.current
      if (delta !== 0) {
        lastRef.current = next
        onDrag(delta)
      }
    },
    [orientation, onDrag],
  )

  const end = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (lastRef.current === null) return
      lastRef.current = null
      setDragging(false)
      document.body.classList.remove(DRAGGING_CLASS)
      document.body.classList.remove(`${DRAGGING_CLASS}-${orientation}`)
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // Already released — fine.
      }
    },
    [orientation],
  )

  return (
    <div
      className={
        'splitter ' +
        orientation +
        (dragging ? ' dragging' : '') +
        (className ? ' ' + className : '')
      }
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    />
  )
}
