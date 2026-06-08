// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { NewStoryModal } from './NewStoryModal'

afterEach(cleanup)

describe('NewStoryModal', () => {
  it('disables Create until a title is entered', () => {
    render(<NewStoryModal onClose={() => {}} onCreate={vi.fn()} />)
    const create = screen.getByRole('button', { name: /create story/i }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Add login' } })
    expect(create.disabled).toBe(false)
  })

  it('submits the collected fields with an unassigned team (hive decides the repo)', () => {
    const onCreate = vi.fn()
    render(<NewStoryModal onClose={() => {}} onCreate={onCreate} />)
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Add login' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'do it' } })
    fireEvent.click(screen.getByRole('button', { name: /create story/i }))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Add login', body: 'do it', team: '', role: expect.any(String) }),
    )
  })

  it('trims and filters acceptance criteria on submit', () => {
    const onCreate = vi.fn()
    render(<NewStoryModal onClose={() => {}} onCreate={onCreate} />)
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'X' } })
    fireEvent.change(screen.getByLabelText(/acceptance criterion 1/i), { target: { value: '  needs validation  ' } })
    fireEvent.click(screen.getByRole('button', { name: /create story/i }))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ acceptanceCriteria: ['needs validation'] }),
    )
  })

  it('closes on overlay click', () => {
    const onClose = vi.fn()
    const { container } = render(<NewStoryModal onClose={onClose} onCreate={() => {}} />)
    fireEvent.click(container.querySelector('.cmd-overlay') as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
