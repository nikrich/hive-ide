/**
 * Renderer-side LSP client — REQ-007.
 *
 * Glues a (plugin, language) pair to its main-process child server,
 * then wires the server's diagnostics + LSP responses into Monaco.
 *
 * Why we do the protocol bridge by hand rather than via
 * `monaco-languageclient`
 * ---------------------------------------------------------------------
 * The `monaco-languageclient` package is the obvious tool for this job,
 * but every version that supports modern monaco-editor (v8+) requires
 * the `@codingame/monaco-vscode-api` peer — a full vscode-editor API
 * polyfill that would tear up the existing `@monaco-editor/react` +
 * `monaco-editor` setup. We don't need the rest of the vscode polyfill;
 * we only need the protocol bridge.
 *
 * So we use `vscode-jsonrpc` for the JSON-RPC layer (it's protocol-pure,
 * no UI dependencies) and `vscode-languageserver-protocol` for the
 * request/notification type constants, and we register Monaco providers
 * (completion, hover, diagnostics, etc.) by hand. Each provider just
 * issues an LSP request and maps the result back to Monaco's shapes.
 *
 * Framing
 * -------
 * LSP wire format is `Content-Length: N\r\n\r\n<json>` per message. The
 * main-process bridge ships *raw bytes* (base64-encoded over IPC) — it
 * does no framing of its own — so we feed those bytes into a custom
 * `AbstractMessageReader`/`AbstractMessageWriter` pair that vscode-jsonrpc
 * accepts. The reader buffers incoming chunks and emits one Message per
 * complete `Content-Length` frame; the writer prepends the header and
 * sends the framed bytes back through the bridge.
 *
 * Reuse
 * -----
 * A module-level cache keys clients by `${pluginId}:${language}`. The
 * MonacoEditor effect fires `startLspClientForPlugin` once per (plugin,
 * language) pair regardless of how many files of that language are
 * open; we hand back the existing client on subsequent calls. The
 * Monaco providers are registered once per Monaco namespace per
 * language id.
 */

import {
  AbstractMessageReader,
  AbstractMessageWriter,
  DataCallback,
  Disposable,
  Emitter,
  Event,
  MessageReader,
  MessageWriter,
  createMessageConnection,
  type Message,
  type MessageConnection,
} from 'vscode-jsonrpc/browser'
import {
  CompletionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  type CompletionItem,
  type CompletionList,
  type Diagnostic,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol'

import type * as Monaco from 'monaco-editor'

import type { LoadedPlugin } from '../../../types/workspace'

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Tracks one connected LSP client per `${pluginId}:${language}`. Build is
 * lazy + idempotent; teardown is by `stop()` or by a server exit event.
 */
interface ActiveClient {
  pluginId: string
  language: string
  sessionId: string
  connection: MessageConnection
  /** Per-document text version, incremented on each change. */
  versions: Map<string, number>
  /** Disposable cleanup hooks — Monaco model change listeners etc. */
  disposables: Disposable[]
  /** Initialize result — capabilities the server advertised. */
  capabilities: InitializeResult['capabilities'] | null
}

const clients = new Map<string, ActiveClient>()
const inFlight = new Map<string, Promise<ActiveClient>>()
/** Tracks `${monacoMark}:${language}` so we register providers exactly once. */
const providersRegistered = new Set<string>()

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Start (or reuse) the LSP client for `(plugin, language)`. Idempotent —
 * the second call returns the cached client. Race-safe — a concurrent
 * second call awaits the first's in-flight build.
 *
 * `defaultCwd` (typically the first repo of the active project) is
 * threaded into the spawn request when the manifest contribution has no
 * `cwd` of its own. Used for jdtls's "workspace root" notion.
 */
export async function startLspClientForPlugin(
  plugin: LoadedPlugin,
  language: string,
  monaco: typeof Monaco,
  opts: { defaultCwd?: string } = {},
): Promise<ActiveClient> {
  const key = `${plugin.manifest.id}:${language}`
  const existing = clients.get(key)
  if (existing !== undefined) return existing
  const pending = inFlight.get(key)
  if (pending !== undefined) return pending

  const promise = buildClient(plugin, language, monaco, opts.defaultCwd)
  inFlight.set(key, promise)
  try {
    const client = await promise
    clients.set(key, client)
    return client
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Tear down the cached client for `(pluginId, language)`. Closes the
 * JSON-RPC connection, asks main to dispose the server, releases any
 * Monaco listeners. Safe to call when nothing is cached.
 */
export async function stopLspClientForPlugin(
  pluginId: string,
  language: string,
): Promise<void> {
  const key = `${pluginId}:${language}`
  const client = clients.get(key)
  if (client === undefined) return
  clients.delete(key)
  for (const d of client.disposables) {
    try {
      d.dispose()
    } catch {
      // ignore disposer failures during teardown
    }
  }
  try {
    client.connection.dispose()
  } catch {
    // ignore
  }
  try {
    await window.hive.lsp.stop(client.sessionId)
  } catch {
    // main may have already exited the process
  }
}

/**
 * Test/teardown escape hatch — wipe every cached client. Not used in
 * production; the unit tests call this between cases.
 */
export function _resetLspClients(): void {
  clients.clear()
  inFlight.clear()
  providersRegistered.clear()
}

// ---------------------------------------------------------------------------
// LSP framing — public for tests
// ---------------------------------------------------------------------------

/**
 * Frame an LSP message: `Content-Length: <len>\r\n\r\n<json>`. Lifted
 * straight from the LSP spec; same as what `vscode-jsonrpc`'s built-in
 * writer emits, but we need the byte form to ship through IPC.
 */
export function frameLspMessage(json: string): Uint8Array {
  const body = new TextEncoder().encode(json)
  const header = new TextEncoder().encode(
    `Content-Length: ${body.byteLength}\r\n\r\n`,
  )
  const out = new Uint8Array(header.byteLength + body.byteLength)
  out.set(header, 0)
  out.set(body, header.byteLength)
  return out
}

/**
 * Stream parser: accepts arbitrary chunks of raw LSP bytes and emits
 * one parsed JSON-RPC message per complete frame. The state machine is
 * just "scan for `\r\n\r\n`, then read Content-Length bytes" — robust
 * against any chunking the underlying pipe applies.
 */
export class LspFrameParser {
  #buffer: Uint8Array = new Uint8Array(0)
  #expected: number | null = null

  /**
   * Push `chunk` into the parser and pull out every complete frame. The
   * leftover (partial header or partial body) stays buffered for the
   * next call.
   */
  feed(chunk: Uint8Array): string[] {
    this.#buffer = concat(this.#buffer, chunk)
    const frames: string[] = []
    while (true) {
      if (this.#expected === null) {
        const headerEnd = indexOfDoubleCrlf(this.#buffer)
        if (headerEnd === -1) break
        const headerText = new TextDecoder('ascii').decode(
          this.#buffer.slice(0, headerEnd),
        )
        const length = parseContentLength(headerText)
        if (length === null) {
          // Malformed header — drop everything up to the boundary and
          // hope the next frame is intact. Bytes ahead of a malformed
          // header are unrecoverable per the LSP spec.
          this.#buffer = this.#buffer.slice(headerEnd + 4)
          continue
        }
        this.#expected = length
        this.#buffer = this.#buffer.slice(headerEnd + 4)
      }
      if (this.#expected === null) break
      if (this.#buffer.byteLength < this.#expected) break
      const body = this.#buffer.slice(0, this.#expected)
      this.#buffer = this.#buffer.slice(this.#expected)
      this.#expected = null
      frames.push(new TextDecoder().decode(body))
    }
    return frames
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

function indexOfDoubleCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i
    }
  }
  return -1
}

function parseContentLength(headerBlock: string): number | null {
  for (const line of headerBlock.split(/\r\n/)) {
    const match = /^Content-Length:\s*(\d+)\s*$/i.exec(line)
    if (match !== null) {
      const n = Number(match[1])
      if (Number.isFinite(n) && n >= 0) return n
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Reader / writer bound to the IPC bridge
// ---------------------------------------------------------------------------

/**
 * Bridge-backed `MessageReader`. vscode-jsonrpc owns the JSON-RPC layer
 * (request/response correlation, notification dispatch); we feed it
 * `Message` objects parsed out of the raw byte stream.
 */
class IpcMessageReader extends AbstractMessageReader implements MessageReader {
  readonly #parser = new LspFrameParser()
  #callback: DataCallback | null = null
  #unsubscribe: (() => void) | null = null

  constructor(sessionId: string) {
    super()
    this.#unsubscribe = window.hive.lsp.onData(sessionId, (base64) => {
      if (this.#callback === null) return
      const chunk = base64ToBytes(base64)
      const frames = this.#parser.feed(chunk)
      for (const json of frames) {
        try {
          const message = JSON.parse(json) as Message
          this.#callback(message)
        } catch (err) {
          this.fireError(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })
  }

  listen(callback: DataCallback): Disposable {
    this.#callback = callback
    return {
      dispose: () => {
        this.#callback = null
      },
    }
  }

  override dispose(): void {
    super.dispose()
    this.#callback = null
    if (this.#unsubscribe !== null) {
      this.#unsubscribe()
      this.#unsubscribe = null
    }
  }
}

/**
 * Bridge-backed `MessageWriter`. Stringifies the JSON-RPC message,
 * frames it with `Content-Length`, base64-encodes the bytes, and ships
 * them across the IPC bridge to the main-process child stdin.
 */
class IpcMessageWriter extends AbstractMessageWriter implements MessageWriter {
  readonly #sessionId: string
  readonly #onClose: Emitter<void> = new Emitter<void>()

  constructor(sessionId: string) {
    super()
    this.#sessionId = sessionId
  }

  async write(message: Message): Promise<void> {
    const framed = frameLspMessage(JSON.stringify(message))
    const base64 = bytesToBase64(framed)
    try {
      await window.hive.lsp.write(this.#sessionId, base64)
    } catch (err) {
      this.fireError(
        err instanceof Error ? err : new Error(String(err)),
        message,
      )
    }
  }

  end(): void {
    this.#onClose.fire()
  }

  override get onClose(): Event<void> {
    return this.#onClose.event
  }

  override dispose(): void {
    super.dispose()
    this.#onClose.dispose()
  }
}

// Base64 helpers — `Buffer` is Node-only; the renderer ships a browser-style
// chunk where we use `btoa` / `atob`.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i])
  }
  return btoa(bin)
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

async function buildClient(
  plugin: LoadedPlugin,
  language: string,
  monaco: typeof Monaco,
  defaultCwd: string | undefined,
): Promise<ActiveClient> {
  // Setup downloads run before the spawn. Idempotent — the second call
  // returns immediately if everything's on disk. We mirror progress
  // events onto a `window.CustomEvent` ('hive:lsp-progress') so a UI
  // shell (Editor.tsx's Toast) can render them without needing to know
  // anything about plugins. The event payload is `{ pluginId, message }`.
  await window.hive.plugins.runSetup(plugin.manifest.id, (message) => {
    // Visible-in-DevTools fallback. The Editor toast subscribes to the
    // CustomEvent below.
    // eslint-disable-next-line no-console
    console.info(`[lsp:${plugin.manifest.id}] ${message}`)
    try {
      window.dispatchEvent(
        new CustomEvent('hive:lsp-progress', {
          detail: { pluginId: plugin.manifest.id, message },
        }),
      )
    } catch {
      // CustomEvent may not exist in odd test envs; the console.info is
      // enough of a fallback.
    }
  })

  const { sessionId, initializationOptions } = await window.hive.lsp.start({
    pluginId: plugin.manifest.id,
    language,
    defaultCwd,
  })

  const reader = new IpcMessageReader(sessionId)
  const writer = new IpcMessageWriter(sessionId)
  const connection = createMessageConnection(reader, writer)

  const client: ActiveClient = {
    pluginId: plugin.manifest.id,
    language,
    sessionId,
    connection,
    versions: new Map(),
    disposables: [],
    capabilities: null,
  }

  // Diagnostics — fired by the server as the user types. Routed through
  // Monaco's marker API per language.
  connection.onNotification(
    PublishDiagnosticsNotification.type,
    (params: PublishDiagnosticsParams) => {
      const uri = params.uri
      const model = monaco.editor
        .getModels()
        .find((m) => m.uri.toString() === uri)
      if (model === undefined) return
      monaco.editor.setModelMarkers(
        model,
        `lsp:${plugin.manifest.id}:${language}`,
        params.diagnostics.map((d) => lspDiagnosticToMarker(d, monaco)),
      )
    },
  )

  // Surface server exits so a future re-open re-spawns the process.
  window.hive.lsp.onExit(sessionId, () => {
    clients.delete(`${plugin.manifest.id}:${language}`)
  })

  connection.listen()

  // initialize -> initialized.
  const params: InitializeParams = {
    processId: null,
    rootUri: defaultCwd !== undefined ? pathToFileUri(defaultCwd) : null,
    capabilities: clientCapabilities(),
    initializationOptions: initializationOptions ?? undefined,
    workspaceFolders:
      defaultCwd !== undefined
        ? [{ uri: pathToFileUri(defaultCwd), name: 'workspace' }]
        : null,
  }
  const result = await connection.sendRequest(InitializeRequest.type, params)
  client.capabilities = result.capabilities
  await connection.sendNotification(InitializedNotification.type, {})

  // Wire Monaco providers for the language id. One-time per (monaco,
  // language) — they read from the live `client` map at call time, so
  // re-registering after a server restart is harmless.
  ensureProvidersRegistered(monaco, plugin.manifest.id, language)

  // didOpen for every already-open model whose language matches. New
  // models opened later are caught by the language-change listener
  // installed inside `ensureProvidersRegistered`.
  for (const model of monaco.editor.getModels()) {
    if (model.getLanguageId() === language) {
      sendDidOpen(client, model)
    }
  }

  return client
}

function clientCapabilities(): InitializeParams['capabilities'] {
  // Narrow capability set — we register Monaco bindings for these and
  // nothing else. Servers that try to push e.g. workspace/configuration
  // requests will get a method-not-found until we wire it up.
  return {
    textDocument: {
      synchronization: {
        dynamicRegistration: false,
        didSave: false,
        willSave: false,
        willSaveWaitUntil: false,
      },
      completion: {
        dynamicRegistration: false,
        completionItem: { snippetSupport: true },
      },
      hover: {
        dynamicRegistration: false,
        contentFormat: ['markdown', 'plaintext'],
      },
      publishDiagnostics: { relatedInformation: true },
    },
  }
}

// ---------------------------------------------------------------------------
// Monaco provider bindings
// ---------------------------------------------------------------------------

/**
 * Idempotently register Monaco completion + hover providers for the
 * language id. The providers route through the live client cache so a
 * server restart (which builds a fresh `ActiveClient`) is invisible at
 * the Monaco surface.
 */
function ensureProvidersRegistered(
  monaco: typeof Monaco,
  pluginId: string,
  language: string,
): void {
  const monacoMark = monacoIdentity(monaco)
  const key = `${monacoMark}:${language}`
  if (providersRegistered.has(key)) return
  providersRegistered.add(key)

  // didOpen / didChange / didClose wiring — once per Monaco namespace per
  // language. Models with the right language id flow into the active
  // client for THIS language; foreign models are ignored.
  const fireOpen = (model: Monaco.editor.ITextModel): void => {
    if (model.getLanguageId() !== language) return
    const client = findClientForLanguage(language)
    if (client === null) return
    sendDidOpen(client, model)
    const sub = model.onDidChangeContent(() => {
      sendDidChange(client, model)
    })
    model.onWillDispose(() => {
      sub.dispose()
      sendDidClose(client, model)
    })
  }
  monaco.editor.onDidCreateModel(fireOpen)
  monaco.editor.onWillDisposeModel((model) => {
    if (model.getLanguageId() !== language) return
    const client = findClientForLanguage(language)
    if (client === null) return
    sendDidClose(client, model)
  })

  monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems: async (model, position) => {
      const client = findClientForLanguage(language)
      if (client === null) return { suggestions: [] }
      const items = await client.connection.sendRequest(
        CompletionRequest.type,
        {
          textDocument: { uri: model.uri.toString() },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        },
      )
      const list = isCompletionList(items)
        ? items.items
        : Array.isArray(items)
          ? items
          : []
      return {
        suggestions: list.map((c) => lspCompletionToMonaco(c, monaco, position)),
      }
    },
  })

  monaco.languages.registerHoverProvider(language, {
    provideHover: async (model, position) => {
      const client = findClientForLanguage(language)
      if (client === null) return null
      const hover = await client.connection.sendRequest(HoverRequest.type, {
        textDocument: { uri: model.uri.toString() },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      })
      if (hover === null || hover === undefined) return null
      return lspHoverToMonaco(hover)
    },
  })

  // Unused param — pluginId is kept so a future caller can scope marker
  // ids etc. without resignaturing.
  void pluginId
}

function findClientForLanguage(language: string): ActiveClient | null {
  for (const client of clients.values()) {
    if (client.language === language) return client
  }
  return null
}

function sendDidOpen(
  client: ActiveClient,
  model: Monaco.editor.ITextModel,
): void {
  const uri = model.uri.toString()
  client.versions.set(uri, 1)
  void client.connection.sendNotification(
    DidOpenTextDocumentNotification.type,
    {
      textDocument: {
        uri,
        languageId: model.getLanguageId(),
        version: 1,
        text: model.getValue(),
      },
    },
  )
}

function sendDidChange(
  client: ActiveClient,
  model: Monaco.editor.ITextModel,
): void {
  const uri = model.uri.toString()
  const next = (client.versions.get(uri) ?? 1) + 1
  client.versions.set(uri, next)
  // Use full-text sync — Monaco's incremental change events translate
  // cleanly but full-text keeps the bridge robust against missed events.
  void client.connection.sendNotification(
    DidChangeTextDocumentNotification.type,
    {
      textDocument: { uri, version: next },
      contentChanges: [{ text: model.getValue() }],
    },
  )
}

function sendDidClose(
  client: ActiveClient,
  model: Monaco.editor.ITextModel,
): void {
  const uri = model.uri.toString()
  client.versions.delete(uri)
  void client.connection.sendNotification(
    DidCloseTextDocumentNotification.type,
    { textDocument: { uri } },
  )
}

// ---------------------------------------------------------------------------
// LSP ↔ Monaco shape mappers
// ---------------------------------------------------------------------------

function lspDiagnosticToMarker(
  d: Diagnostic,
  monaco: typeof Monaco,
): Monaco.editor.IMarkerData {
  return {
    severity: severityMap(d.severity, monaco),
    message: d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    source: d.source,
    code: typeof d.code === 'string' || typeof d.code === 'number' ? String(d.code) : undefined,
  }
}

function severityMap(
  s: Diagnostic['severity'],
  monaco: typeof Monaco,
): Monaco.MarkerSeverity {
  switch (s) {
    case 1:
      return monaco.MarkerSeverity.Error
    case 2:
      return monaco.MarkerSeverity.Warning
    case 3:
      return monaco.MarkerSeverity.Info
    case 4:
      return monaco.MarkerSeverity.Hint
    default:
      return monaco.MarkerSeverity.Info
  }
}

function lspCompletionToMonaco(
  c: CompletionItem,
  monaco: typeof Monaco,
  position: Monaco.Position,
): Monaco.languages.CompletionItem {
  return {
    label: c.label,
    kind: c.kind !== undefined ? (c.kind as unknown as Monaco.languages.CompletionItemKind) : monaco.languages.CompletionItemKind.Text,
    insertText: c.insertText ?? c.label,
    detail: c.detail,
    documentation:
      typeof c.documentation === 'string'
        ? c.documentation
        : c.documentation?.value,
    range: new monaco.Range(
      position.lineNumber,
      position.column,
      position.lineNumber,
      position.column,
    ),
  }
}

function lspHoverToMonaco(hover: Hover): Monaco.languages.Hover {
  const contents = Array.isArray(hover.contents)
    ? hover.contents.map((c) =>
        typeof c === 'string' ? { value: c } : { value: c.value },
      )
    : typeof hover.contents === 'string'
      ? [{ value: hover.contents }]
      : [{ value: hover.contents.value }]
  return { contents }
}

function isCompletionList(
  v: CompletionItem[] | CompletionList | null,
): v is CompletionList {
  return v !== null && typeof v === 'object' && 'items' in v && Array.isArray((v as CompletionList).items)
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function monacoIdentity(monaco: typeof Monaco): string {
  // Different Monaco namespace instances would each need their own
  // provider registration. We don't expect more than one in production
  // but the test environment may construct several — key off a property
  // that's stable across renders within one namespace.
  const ns = monaco as unknown as { __hiveLspMark?: string }
  if (ns.__hiveLspMark === undefined) {
    ns.__hiveLspMark = `monaco-${Math.random().toString(36).slice(2, 10)}`
  }
  return ns.__hiveLspMark
}

function pathToFileUri(path: string): string {
  // Minimal — `file://` plus the absolute path. Windows-aware (extra
  // slash for drive letters): `file:///C:/foo` vs `file:///home/foo`.
  if (/^[a-zA-Z]:/.test(path)) {
    return `file:///${path.replace(/\\/g, '/')}`
  }
  return `file://${path}`
}
