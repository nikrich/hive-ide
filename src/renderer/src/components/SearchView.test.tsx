// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import SearchView from './SearchView'
import { useWorkspaceStore } from '../store/workspaceStore'

const filesMock = vi.fn()
const replaceMock = vi.fn()

const RESULT = {
  results: [
    {
      file: '/repo/a.ts',
      matches: [
        { line: 1, preview: 'foo one', ranges: [{ start: 0, end: 3 }] },
        { line: 5, preview: 'foo five', ranges: [{ start: 0, end: 3 }] },
      ],
    },
    {
      file: '/repo/b.ts',
      matches: [{ line: 2, preview: 'foo two', ranges: [{ start: 0, end: 3 }] }],
    },
  ],
  truncated: false,
  total: 3,
}

beforeEach(() => {
  vi.useFakeTimers()
  filesMock.mockClear()
  replaceMock.mockClear()
  filesMock.mockResolvedValue(RESULT)
  replaceMock.mockResolvedValue({ filesChanged: 2, replacements: 2 })
  ;(window as unknown as { hive: unknown }).hive = {
    search: { files: filesMock, replace: replaceMock, listFiles: vi.fn() },
  }
  useWorkspaceStore.setState({
    repos: [{ path: '/repo', name: 'repo' }] as never,
  })
  // Node's experimental webstorage shadows happy-dom's Storage with a
  // method-less object, so guard the call (persistence is inert in tests).
  window.localStorage.clear?.()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

async function searchFor(query: string): Promise<void> {
  render(<SearchView />)
  fireEvent.change(screen.getByLabelText('Search query'), {
    target: { value: query },
  })
  // waitFor can't be used here: @testing-library/dom only auto-advances fake
  // timers when a `jest` global exists, so under vitest it would hang. An
  // act-wrapped advance flushes both the debounce timer and React updates.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0)
}

describe('SearchView per-match opt-out', () => {
  it('renders a checkbox per match row and per file, all checked', async () => {
    await searchFor('foo')
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes).toHaveLength(5)
    expect(boxes.every((b) => b.checked)).toBe(true)
  })

  it('unchecking a match sends it as an excluded line', async () => {
    await searchFor('foo')
    fireEvent.click(screen.getByLabelText('Include match /repo/a.ts:5'))
    fireEvent.click(screen.getByLabelText('Toggle replace'))
    fireEvent.click(screen.getByLabelText('Replace all'))
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        files: ['/repo/a.ts', '/repo/b.ts'],
        excludeLines: { '/repo/a.ts': [5] },
      }),
    )
  })

  it('unchecking a file excludes the whole file from the request', async () => {
    await searchFor('foo')
    fireEvent.click(screen.getByLabelText('Include file /repo/a.ts'))
    fireEvent.click(screen.getByLabelText('Toggle replace'))
    fireEvent.click(screen.getByLabelText('Replace all'))
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ files: ['/repo/b.ts'] }),
    )
    const payload = replaceMock.mock.calls[0][0] as { excludeLines?: unknown }
    expect(payload.excludeLines ?? {}).toEqual({})
  })

  it('clicking a partially-excluded file checkbox excludes all its matches', async () => {
    await searchFor('foo')
    fireEvent.click(screen.getByLabelText('Include match /repo/a.ts:5'))
    const fileBox = screen.getByLabelText('Include file /repo/a.ts') as HTMLInputElement
    expect(fileBox.indeterminate).toBe(true)
    fireEvent.click(fileBox)
    fireEvent.click(screen.getByLabelText('Toggle replace'))
    fireEvent.click(screen.getByLabelText('Replace all'))
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ files: ['/repo/b.ts'] }),
    )
  })

  it('does not call replace when every match is excluded', async () => {
    await searchFor('foo')
    fireEvent.click(screen.getByLabelText('Include file /repo/a.ts'))
    fireEvent.click(screen.getByLabelText('Include file /repo/b.ts'))
    fireEvent.click(screen.getByLabelText('Toggle replace'))
    fireEvent.click(screen.getByLabelText('Replace all'))
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(replaceMock).not.toHaveBeenCalled()
  })
})
