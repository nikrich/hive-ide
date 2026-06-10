// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { PRsView } from './PRsView'
import type { PrCard } from '../lib/hiveView'

const CARD: PrCard = {
  storyId: 'S1',
  num: 54,
  title: 'Ship it',
  role: 'senior',
  branch: 'feat/x',
  status: 'review',
  url: 'https://github.com/o/r/pull/54',
  time: '1h ago',
}

const enrichMock = vi.fn()

beforeEach(() => {
  enrichMock.mockReset()
  ;(window as unknown as { hive: unknown }).hive = {
    github: { enrichPrs: enrichMock },
    shell: { openExternal: vi.fn() },
  }
})
afterEach(cleanup)

describe('PRsView enrichment', () => {
  it('renders live state, checks, diffstat and review chips when enriched', async () => {
    enrichMock.mockResolvedValue({
      [CARD.url]: {
        state: 'open',
        isDraft: true,
        additions: 12,
        deletions: 4,
        reviewDecision: 'changes-requested',
        checks: 'failing',
      },
    })
    render(<PRsView prs={[CARD]} projectLabel="proj" />)
    await waitFor(() => expect(screen.getByText('+12')).toBeDefined())
    expect(enrichMock).toHaveBeenCalledWith([CARD.url])
    expect(screen.getByText('−4')).toBeDefined()
    expect(screen.getByText(/draft/i)).toBeDefined()
    expect(screen.getByText(/checks failing/i)).toBeDefined()
    expect(screen.getByText(/changes requested/i)).toBeDefined()
  })

  it('falls back to story-derived rendering and a hint when enrichment is all-null', async () => {
    enrichMock.mockResolvedValue({ [CARD.url]: null })
    render(<PRsView prs={[CARD]} projectLabel="proj" />)
    await waitFor(() =>
      expect(screen.getByText(/Live GitHub status unavailable/i)).toBeDefined(),
    )
    expect(screen.queryByText('+12')).toBeNull()
  })

  it('renders plainly when the github bridge is absent', () => {
    ;(window as unknown as { hive: unknown }).hive = { shell: { openExternal: vi.fn() } }
    render(<PRsView prs={[CARD]} projectLabel="proj" />)
    expect(screen.getByText('Ship it')).toBeDefined()
    expect(screen.queryByText(/unavailable/i)).toBeNull()
  })
})
