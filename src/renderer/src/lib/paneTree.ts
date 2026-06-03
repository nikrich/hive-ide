/**
 * Pane-tree model + layout for the full-screen terminal (REQ terminal view).
 *
 * The terminal stage is a binary split tree. The RENDERING, however, must not
 * mirror that tree onto the React element hierarchy — doing so remounts a
 * pane's `<XtermPane>` whenever the tree reshapes around it (e.g. on split),
 * which disposes its pty and wipes the shell. See `TerminalView.tsx`.
 *
 * Instead {@link computeLayout} flattens the tree into:
 *   - a flat list of pane boxes (id + rect in %), rendered as keyed siblings
 *     of one stable container so React preserves each pane's identity across
 *     splits/resizes;
 *   - a flat list of divider bars (the split id + where to draw + the split's
 *     rect, used to convert a pointer drag back into a [a, b] size pair).
 *
 * All geometry is in percentages of the stage (0–100) so the rendered panes
 * are pure CSS positioning with no measurement pass.
 */

export type SplitDir = 'row' | 'col'

/** A leaf (one terminal) or a binary split of two child nodes. */
export type PaneNode =
  | { type: 'pane'; id: string }
  | {
      type: 'split'
      id: string
      dir: SplitDir
      /** Size weights for [a, b]; need not sum to 100 — normalised on use. */
      sizes: [number, number]
      a: PaneNode
      b: PaneNode
    }

/** Rectangle in stage percentages. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface PaneBox {
  id: string
  rect: Rect
}

export interface DividerBox {
  /** The split node's id — the resize target. */
  id: string
  dir: SplitDir
  /** Thin rect where the divider bar is drawn (w or h is 0 at the seam). */
  pos: Rect
  /** The split's full rect — lets a drag map pointer px → fraction. */
  split: Rect
}

export interface Layout {
  panes: PaneBox[]
  dividers: DividerBox[]
}

// ---------------------------------------------------------------------------
// Tree helpers (pure)
// ---------------------------------------------------------------------------

/** Ids of every leaf, left-to-right / top-to-bottom. */
export function paneIds(n: PaneNode): string[] {
  return n.type === 'pane' ? [n.id] : [...paneIds(n.a), ...paneIds(n.b)]
}

/** Replace the leaf with id `id` by `fn(leaf)`, returning a new tree. */
export function replaceLeaf(
  n: PaneNode,
  id: string,
  fn: (leaf: PaneNode) => PaneNode,
): PaneNode {
  if (n.type === 'pane') return n.id === id ? fn(n) : n
  return { ...n, a: replaceLeaf(n.a, id, fn), b: replaceLeaf(n.b, id, fn) }
}

/** Remove the leaf with id `id`, collapsing its now-only-child split. */
export function removeLeaf(n: PaneNode, id: string): PaneNode | null {
  if (n.type === 'pane') return n.id === id ? null : n
  const a = removeLeaf(n.a, id)
  const b = removeLeaf(n.b, id)
  if (a === null) return b
  if (b === null) return a
  return { ...n, a, b }
}

/** Update a split node's sizes by split id. */
export function sizeSplit(
  n: PaneNode,
  id: string,
  sizes: [number, number],
): PaneNode {
  if (n.type === 'pane') return n
  if (n.id === id) return { ...n, sizes }
  return { ...n, a: sizeSplit(n.a, id, sizes), b: sizeSplit(n.b, id, sizes) }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 }

/**
 * Flatten a pane tree into absolutely-positioned pane + divider boxes.
 *
 * @param node the tree to lay out
 * @param rect the rect (in %) the tree occupies; defaults to the full stage
 */
export function computeLayout(node: PaneNode, rect: Rect = FULL): Layout {
  if (node.type === 'pane') {
    return { panes: [{ id: node.id, rect }], dividers: [] }
  }

  const [sa, sb] = node.sizes
  const total = sa + sb || 1
  const fa = sa / total

  let aRect: Rect
  let bRect: Rect
  let pos: Rect

  if (node.dir === 'row') {
    const aw = rect.w * fa
    aRect = { x: rect.x, y: rect.y, w: aw, h: rect.h }
    bRect = { x: rect.x + aw, y: rect.y, w: rect.w - aw, h: rect.h }
    pos = { x: rect.x + aw, y: rect.y, w: 0, h: rect.h }
  } else {
    const ah = rect.h * fa
    aRect = { x: rect.x, y: rect.y, w: rect.w, h: ah }
    bRect = { x: rect.x, y: rect.y + ah, w: rect.w, h: rect.h - ah }
    pos = { x: rect.x, y: rect.y + ah, w: rect.w, h: 0 }
  }

  const la = computeLayout(node.a, aRect)
  const lb = computeLayout(node.b, bRect)
  const divider: DividerBox = { id: node.id, dir: node.dir, pos, split: rect }

  return {
    panes: [...la.panes, ...lb.panes],
    dividers: [divider, ...la.dividers, ...lb.dividers],
  }
}
