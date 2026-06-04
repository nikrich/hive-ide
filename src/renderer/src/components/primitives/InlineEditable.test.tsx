// @vitest-environment happy-dom
import { createRef } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

import { InlineEditable } from './InlineEditable'
import type { InlineEditableHandle } from './InlineEditable'

afterEach(cleanup)

describe('InlineEditable', () => {
  it('shows the value as text until double-clicked', () => {
    render(<InlineEditable value="acme" onCommit={() => {}} />)
    expect(screen.getByText('acme')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('commits the trimmed value on Enter', () => {
    const onCommit = vi.fn()
    render(<InlineEditable value="acme" onCommit={onCommit} />)
    fireEvent.doubleClick(screen.getByText('acme'))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  payments  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('payments')
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('commits on blur', () => {
    const onCommit = vi.fn()
    render(<InlineEditable value="acme" onCommit={onCommit} />)
    fireEvent.doubleClick(screen.getByText('acme'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('renamed')
  })

  it('cancels on Escape without committing', () => {
    const onCommit = vi.fn()
    render(<InlineEditable value="acme" onCommit={onCommit} />)
    fireEvent.doubleClick(screen.getByText('acme'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByText('acme')).toBeTruthy()
  })

  it('ignores an empty commit', () => {
    const onCommit = vi.fn()
    render(<InlineEditable value="acme" onCommit={onCommit} />)
    fireEvent.doubleClick(screen.getByText('acme'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not commit when the value is unchanged', () => {
    const onCommit = vi.fn()
    render(<InlineEditable value="acme" onCommit={onCommit} />)
    fireEvent.doubleClick(screen.getByText('acme'))
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('enters edit mode via the startEditing() handle', () => {
    const ref = createRef<InlineEditableHandle>()
    render(<InlineEditable ref={ref} value="acme" onCommit={() => {}} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    act(() => ref.current?.startEditing())
    expect(screen.getByRole('textbox')).toBeTruthy()
  })
})
