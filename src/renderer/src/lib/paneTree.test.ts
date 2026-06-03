import { describe, expect, it } from 'vitest'

import {
  computeLayout,
  paneIds,
  removeLeaf,
  replaceLeaf,
  sizeSplit,
  type PaneNode,
} from './paneTree'

// A leaf, and the split a "split-right" produces around it.
const leaf = (id: string): PaneNode => ({ type: 'pane', id })
const rowSplit = (
  id: string,
  a: PaneNode,
  b: PaneNode,
  sizes: [number, number] = [50, 50],
): PaneNode => ({ type: 'split', id, dir: 'row', sizes, a, b })
const colSplit = (
  id: string,
  a: PaneNode,
  b: PaneNode,
  sizes: [number, number] = [50, 50],
): PaneNode => ({ type: 'split', id, dir: 'col', sizes, a, b })

describe('computeLayout', () => {
  it('lays a single pane over the whole stage with no dividers', () => {
    const layout = computeLayout(leaf('p1'))
    expect(layout.panes).toEqual([{ id: 'p1', rect: { x: 0, y: 0, w: 100, h: 100 } }])
    expect(layout.dividers).toEqual([])
  })

  it('splits a row 50/50 into left + right halves with a vertical divider', () => {
    const layout = computeLayout(rowSplit('s1', leaf('p1'), leaf('p2')))
    expect(layout.panes).toEqual([
      { id: 'p1', rect: { x: 0, y: 0, w: 50, h: 100 } },
      { id: 'p2', rect: { x: 50, y: 0, w: 50, h: 100 } },
    ])
    expect(layout.dividers).toEqual([
      { id: 's1', dir: 'row', pos: { x: 50, y: 0, w: 0, h: 100 }, split: { x: 0, y: 0, w: 100, h: 100 } },
    ])
  })

  it('splits a column 30/70 into top + bottom with a horizontal divider', () => {
    const layout = computeLayout(colSplit('s1', leaf('p1'), leaf('p2'), [30, 70]))
    expect(layout.panes).toEqual([
      { id: 'p1', rect: { x: 0, y: 0, w: 100, h: 30 } },
      { id: 'p2', rect: { x: 0, y: 30, w: 100, h: 70 } },
    ])
    expect(layout.dividers[0]).toEqual({
      id: 's1',
      dir: 'col',
      pos: { x: 0, y: 30, w: 100, h: 0 },
      split: { x: 0, y: 0, w: 100, h: 100 },
    })
  })

  it('honours non-equal weights', () => {
    const layout = computeLayout(rowSplit('s1', leaf('p1'), leaf('p2'), [60, 40]))
    expect(layout.panes[0].rect.w).toBe(60)
    expect(layout.panes[1].rect).toEqual({ x: 60, y: 0, w: 40, h: 100 })
  })

  it('lays out a nested split within a split, sized relative to its parent rect', () => {
    // Outer row 50/50; the right half is itself split into a 50/50 column.
    const tree = rowSplit('s1', leaf('p1'), colSplit('s2', leaf('p2'), leaf('p3')))
    const layout = computeLayout(tree)

    // Every pane survives the flatten, exactly once.
    expect(layout.panes.map((p) => p.id).sort()).toEqual(['p1', 'p2', 'p3'])

    const byId = Object.fromEntries(layout.panes.map((p) => [p.id, p.rect]))
    expect(byId.p1).toEqual({ x: 0, y: 0, w: 50, h: 100 })
    // Nested column halves live inside the right 50%-wide column.
    expect(byId.p2).toEqual({ x: 50, y: 0, w: 50, h: 50 })
    expect(byId.p3).toEqual({ x: 50, y: 50, w: 50, h: 50 })

    // One divider per split node.
    expect(layout.dividers.map((d) => d.id).sort()).toEqual(['s1', 's2'])
    const s2 = layout.dividers.find((d) => d.id === 's2')!
    // The nested divider's fraction is taken against the nested split's rect,
    // not the whole stage — this is what makes nested resize correct.
    expect(s2.split).toEqual({ x: 50, y: 0, w: 50, h: 100 })
  })
})

describe('tree mutation helpers', () => {
  it('paneIds lists leaves left-to-right', () => {
    const tree = rowSplit('s1', leaf('p1'), colSplit('s2', leaf('p2'), leaf('p3')))
    expect(paneIds(tree)).toEqual(['p1', 'p2', 'p3'])
  })

  it('replaceLeaf turns a leaf into a split while leaving siblings untouched', () => {
    const before = rowSplit('s1', leaf('p1'), leaf('p2'))
    const after = replaceLeaf(before, 'p2', (old) => colSplit('s2', old, leaf('p3')))
    expect(paneIds(after)).toEqual(['p1', 'p2', 'p3'])
    // p1's leaf object identity is preserved (only the p2 branch changed).
    expect((after as Extract<PaneNode, { type: 'split' }>).a).toBe(
      (before as Extract<PaneNode, { type: 'split' }>).a,
    )
  })

  it('removeLeaf collapses the now-only-child split', () => {
    const tree = rowSplit('s1', leaf('p1'), leaf('p2'))
    expect(removeLeaf(tree, 'p2')).toEqual(leaf('p1'))
  })

  it('removeLeaf of the only pane returns null', () => {
    expect(removeLeaf(leaf('p1'), 'p1')).toBeNull()
  })

  it('sizeSplit updates only the targeted split', () => {
    const tree = rowSplit('s1', leaf('p1'), colSplit('s2', leaf('p2'), leaf('p3')))
    const next = sizeSplit(tree, 's2', [70, 30]) as Extract<PaneNode, { type: 'split' }>
    expect((next.b as Extract<PaneNode, { type: 'split' }>).sizes).toEqual([70, 30])
    expect(next.sizes).toEqual([50, 50]) // s1 untouched
  })
})
