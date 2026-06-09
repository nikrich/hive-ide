import { describe, expect, it, vi } from 'vitest'

import {
  fileUriToPath,
  lspSymbolKindName,
  queryLspWorkspaceSymbols,
  type LspSymbolClient,
} from './lspWorkspaceSymbols'

function client(
  result: unknown,
  capabilities: Record<string, unknown> = { workspaceSymbolProvider: true },
): LspSymbolClient {
  return {
    language: 'python',
    capabilities,
    connection: { sendRequest: vi.fn().mockResolvedValue(result) },
  }
}

describe('fileUriToPath', () => {
  it('decodes a posix file uri', () => {
    expect(fileUriToPath('file:///home/u/a%20b.py')).toBe('/home/u/a b.py')
  })
  it('decodes a windows file uri', () => {
    expect(fileUriToPath('file:///C:/proj/x.py')).toBe('C:/proj/x.py')
  })
  it('passes through non-file uris unchanged', () => {
    expect(fileUriToPath('untitled:Untitled-1')).toBe('untitled:Untitled-1')
  })
})

describe('queryLspWorkspaceSymbols', () => {
  it('maps SymbolInformation results to WorkspaceSymbol', async () => {
    const c = client([
      {
        name: 'do_thing',
        kind: 12,
        containerName: 'mod',
        location: {
          uri: 'file:///proj/mod.py',
          range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } },
        },
      },
    ])
    const out = await queryLspWorkspaceSymbols([c], 'do')
    expect(out).toEqual([
      {
        name: 'do_thing',
        kind: 'function',
        containerName: 'mod',
        path: '/proj/mod.py',
        line: 5,
        column: 3,
      },
    ])
  })

  it('skips clients whose server lacks workspaceSymbolProvider', async () => {
    const c = client([], {})
    const out = await queryLspWorkspaceSymbols([c], 'x')
    expect(out).toEqual([])
    expect(c.connection.sendRequest).not.toHaveBeenCalled()
  })

  it('queries clients whose workspaceSymbolProvider is an options object', async () => {
    const c = client([], { workspaceSymbolProvider: { workDoneProgress: true } })
    await queryLspWorkspaceSymbols([c], 'x')
    expect(c.connection.sendRequest).toHaveBeenCalledWith('workspace/symbol', { query: 'x' })
  })

  it('maps a rangeless result to line 1 / column 1', async () => {
    const c = client([
      { name: 'no_range', kind: 12, location: { uri: 'file:///p/x.py' } },
    ])
    const out = await queryLspWorkspaceSymbols([c], 'no')
    expect(out).toHaveLength(1)
    expect(out[0].line).toBe(1)
    expect(out[0].column).toBe(1)
  })

  it('survives a rejecting client', async () => {
    const bad: LspSymbolClient = {
      language: 'go',
      capabilities: { workspaceSymbolProvider: true },
      connection: { sendRequest: vi.fn().mockRejectedValue(new Error('boom')) },
    }
    const good = client([
      {
        name: 'ok',
        kind: 5,
        location: { uri: 'file:///p/a.go', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } },
      },
    ])
    const out = await queryLspWorkspaceSymbols([bad, good], 'o')
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('class')
  })
})

describe('lspSymbolKindName', () => {
  it('falls back to "symbol" for unknown kinds', () => {
    expect(lspSymbolKindName(999)).toBe('symbol')
  })
})
