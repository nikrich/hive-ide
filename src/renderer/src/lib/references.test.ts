import { describe, expect, it } from 'vitest'

import { lspLocationsToHits } from './references'

describe('lspLocationsToHits', () => {
  it('maps LSP locations to reference hits with previews from open models', () => {
    const models = [
      {
        uri: { toString: () => 'file:///p/a.py', fsPath: '/p/a.py' },
        getLineContent: (n: number) => (n === 3 ? '  total = add(a, b)' : ''),
      },
    ]
    const hits = lspLocationsToHits(
      [
        {
          uri: 'file:///p/a.py',
          range: { start: { line: 2, character: 10 }, end: { line: 2, character: 13 } },
        },
        {
          uri: 'file:///p/b.py',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        },
      ],
      models as never,
    )
    expect(hits).toEqual([
      { path: '/p/a.py', line: 3, column: 11, preview: 'total = add(a, b)' },
      { path: '/p/b.py', line: 1, column: 1, preview: '' },
    ])
  })

  it('returns [] for null/undefined responses', () => {
    expect(lspLocationsToHits(null, [] as never)).toEqual([])
  })
})
