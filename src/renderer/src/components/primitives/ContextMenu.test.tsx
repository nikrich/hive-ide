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
})
