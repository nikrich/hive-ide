// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { ContextMenu } from './ContextMenu'

afterEach(cleanup)

describe('ContextMenu', () => {
  it('renders items and fires onSelect, then closes', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <ContextMenu
        x={10}
        y={20}
        items={[{ label: 'Rename', onSelect }]}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByText('Rename'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on outside (scrim) click without selecting', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const { container } = render(
      <ContextMenu
        x={0}
        y={0}
        items={[{ label: 'Rename', onSelect }]}
        onClose={onClose}
      />,
    )
    // The scrim is the first child.
    fireEvent.click(container.firstChild as Element)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // The menu is rendered inside the element that opened it (a clickable row).
  // Selecting an item must NOT bubble to that row's onClick — otherwise
  // clicking "Rename" also triggers the row action (e.g. opening the project).
  it('does not propagate clicks to a parent handler', () => {
    const parentClick = vi.fn()
    const onSelect = vi.fn()
    render(
      <div onClick={parentClick} onMouseDown={parentClick}>
        <ContextMenu
          x={5}
          y={5}
          items={[{ label: 'Rename', onSelect }]}
          onClose={() => {}}
        />
      </div>,
    )
    const item = screen.getByText('Rename')
    fireEvent.mouseDown(item)
    fireEvent.click(item)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('does not propagate scrim clicks to a parent handler', () => {
    const parentClick = vi.fn()
    const { container } = render(
      <div onClick={parentClick} onMouseDown={parentClick}>
        <ContextMenu x={0} y={0} items={[]} onClose={() => {}} />
      </div>,
    )
    // The wrapper div is container.firstChild; the scrim is its first child.
    const scrim = (container.firstChild as Element).firstChild as Element
    fireEvent.mouseDown(scrim)
    fireEvent.click(scrim)
    expect(parentClick).not.toHaveBeenCalled()
  })
})
