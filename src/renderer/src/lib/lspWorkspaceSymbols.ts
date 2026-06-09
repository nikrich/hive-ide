/**
 * Plugin-LSP `workspace/symbol` querying (generalizes ⌘T beyond TS/JS).
 *
 * Fans the query out to every connected LSP client whose server advertises
 * `workspaceSymbolProvider`, then maps LSP SymbolInformation / WorkspaceSymbol
 * results into the palette's `WorkspaceSymbol` shape. Pure data-in/data-out
 * over an injected minimal client shape, so it unit-tests without IPC.
 */

import type { WorkspaceSymbol } from './workspaceSymbols'

/** The slice of an ActiveClient this module needs (kept minimal for tests). */
export interface LspSymbolClient {
  language: string
  capabilities: { workspaceSymbolProvider?: unknown } | null
  connection: {
    sendRequest(type: unknown, params: unknown): Promise<unknown>
  }
}

/** LSP SymbolKind (1-26) → human-readable kind names. */
const KIND_NAMES: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class',
  6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum',
  11: 'interface', 12: 'function', 13: 'variable', 14: 'constant',
  15: 'string', 16: 'number', 17: 'boolean', 18: 'array', 19: 'object',
  20: 'key', 21: 'null', 22: 'enum member', 23: 'struct', 24: 'event',
  25: 'operator', 26: 'type parameter',
}

export function lspSymbolKindName(kind: number): string {
  return KIND_NAMES[kind] ?? 'symbol'
}

/**
 * `file://` URI → filesystem path (posix + windows). Non-file URIs pass
 * through. UNC URIs (`file://host/share`) are not specially handled.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  let rest = uri.slice('file://'.length)
  try {
    rest = decodeURIComponent(rest)
  } catch {
    // Malformed percent-encoding from a buggy server: keep the raw string
    // rather than throwing and discarding every other server's results.
  }
  // file:///C:/x → /C:/x → C:/x
  if (/^\/[a-zA-Z]:/.test(rest)) rest = rest.slice(1)
  return rest
}

interface LspSymbolLike {
  name?: unknown
  kind?: unknown
  containerName?: unknown
  location?: { uri?: unknown; range?: { start?: { line?: unknown; character?: unknown } } }
}

export async function queryLspWorkspaceSymbols(
  lspClients: LspSymbolClient[],
  query: string,
  max = 200,
): Promise<WorkspaceSymbol[]> {
  const eligible = lspClients.filter(
    (c) => c.capabilities?.workspaceSymbolProvider !== undefined
      && c.capabilities?.workspaceSymbolProvider !== false,
  )
  const settled = await Promise.allSettled(
    eligible.map((c) =>
      c.connection.sendRequest('workspace/symbol', { query }),
    ),
  )
  const out: WorkspaceSymbol[] = []
  for (const res of settled) {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue
    for (const raw of res.value as LspSymbolLike[]) {
      if (typeof raw?.name !== 'string') continue
      const uri = raw.location?.uri
      const start = raw.location?.range?.start
      if (typeof uri !== 'string') continue
      out.push({
        name: raw.name,
        kind: lspSymbolKindName(typeof raw.kind === 'number' ? raw.kind : -1),
        containerName: typeof raw.containerName === 'string' ? raw.containerName : '',
        path: fileUriToPath(uri),
        line: (typeof start?.line === 'number' ? start.line : 0) + 1,
        column: (typeof start?.character === 'number' ? start.character : 0) + 1,
      })
      if (out.length >= max) return out
    }
  }
  return out
}
