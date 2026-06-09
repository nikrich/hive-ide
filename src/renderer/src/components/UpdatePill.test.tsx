// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { UpdatePill } from './UpdatePill'
import { useUpdaterStore } from '../store/updaterStore'
import type { UpdaterStatus } from '../../../preload/api'

afterEach(cleanup)

function set(status: UpdaterStatus, overrides: Record<string, unknown> = {}): void {
  useUpdaterStore.setState({ status, ...overrides })
}

describe('UpdatePill', () => {
  it('renders nothing for non-update phases (idle / not-available / unsupported)', () => {
    for (const phase of ['idle', 'not-available', 'unsupported', 'checking', 'error'] as const) {
      set({ phase })
      const { container } = render(<UpdatePill />)
      expect(container.firstChild).toBeNull()
      cleanup()
    }
  })

  it('shows "Update available" when an update is available', () => {
    set({ phase: 'available', version: '9.9.9' })
    render(<UpdatePill />)
    expect(screen.getByRole('button', { name: /update available/i })).toBeTruthy()
  })

  it('shows the rounded download percent while downloading', () => {
    set({ phase: 'downloading', percent: 42.6 })
    render(<UpdatePill />)
    expect(screen.getByRole('button', { name: /43%/ })).toBeTruthy()
  })

  it('shows "Restart to update" and calls quitAndInstall on click when downloaded', () => {
    const quitAndInstall = vi.fn()
    set({ phase: 'downloaded', version: '9.9.9' }, { quitAndInstall })
    render(<UpdatePill />)
    const btn = screen.getByRole('button', { name: /restart to update/i })
    fireEvent.click(btn)
    expect(quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('does not act on click before the update is downloaded', () => {
    const quitAndInstall = vi.fn()
    set({ phase: 'downloading', percent: 10 }, { quitAndInstall })
    render(<UpdatePill />)
    fireEvent.click(screen.getByRole('button'))
    expect(quitAndInstall).not.toHaveBeenCalled()
  })
})
