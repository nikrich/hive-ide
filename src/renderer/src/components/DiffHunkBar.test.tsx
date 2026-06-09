// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DiffHunkBar } from './DiffHunkBar'
import type { DiffHunk } from '../lib/diffHunks'

afterEach(cleanup)

const HUNKS: DiffHunk[] = [
  { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, header: '@@ -1,2 +1,3 @@', lines: [' a', '+b', ' c'] },
  { oldStart: 9, oldLines: 1, newStart: 10, newLines: 1, header: '@@ -9 +10 @@', lines: ['-x', '+y'] },
]

describe('DiffHunkBar', () => {
  it('renders one action per hunk with stage labels', () => {
    const onApply = vi.fn()
    render(<DiffHunkBar hunks={HUNKS} mode="stage" busyIndex={null} onApply={onApply} />)
    const buttons = screen.getAllByRole('button', { name: /stage hunk/i })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(onApply).toHaveBeenCalledWith(1)
  })

  it('uses unstage labels in unstage mode and disables while busy', () => {
    render(<DiffHunkBar hunks={HUNKS} mode="unstage" busyIndex={0} onApply={vi.fn()} />)
    const buttons = screen.getAllByRole('button', { name: /unstage hunk/i })
    expect(buttons).toHaveLength(2)
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders nothing when there are no hunks', () => {
    const { container } = render(
      <DiffHunkBar hunks={[]} mode="stage" busyIndex={null} onApply={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
