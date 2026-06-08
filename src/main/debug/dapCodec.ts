/**
 * Debug Adapter Protocol message codec (E3-01).
 *
 * DAP uses the same `Content-Length`-framed JSON transport as the Language
 * Server Protocol. This module is the pure, dependency-free framing core a DAP
 * client builds on:
 *
 *   - {@link encodeMessage} serialises a protocol message to a wire buffer.
 *   - {@link DapMessageReader} accumulates raw stdout chunks and emits each
 *     complete JSON message as it arrives (handling partial / coalesced reads).
 *
 * Keeping this separate from process spawning makes it unit-testable without an
 * actual adapter, mirroring how `plugins/lsp` factors its transport.
 */

/** A decoded DAP protocol message (request / response / event). */
export type DapMessage = Record<string, unknown>

const HEADER_SEPARATOR = '\r\n\r\n'

/** Serialise a DAP message into a `Content-Length`-framed buffer. */
export function encodeMessage(message: DapMessage): Buffer {
  const json = JSON.stringify(message)
  const body = Buffer.from(json, 'utf8')
  const header = Buffer.from(
    `Content-Length: ${body.length}\r\n\r\n`,
    'ascii',
  )
  return Buffer.concat([header, body])
}

/**
 * Streaming reader for `Content-Length`-framed DAP messages. Feed it raw
 * chunks via {@link push}; it invokes the `onMessage` callback once per fully
 * received message. Robust to chunk boundaries falling anywhere (mid-header,
 * mid-body, or multiple messages in one chunk).
 */
export class DapMessageReader {
  #buffer = Buffer.alloc(0)
  readonly #onMessage: (message: DapMessage) => void
  readonly #onError: (error: Error) => void

  constructor(
    onMessage: (message: DapMessage) => void,
    onError: (error: Error) => void = () => undefined,
  ) {
    this.#onMessage = onMessage
    this.#onError = onError
  }

  /** Append a chunk and drain any complete messages it completes. */
  push(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    this.#drain()
  }

  #drain(): void {
    for (;;) {
      const headerEnd = this.#buffer.indexOf(HEADER_SEPARATOR)
      if (headerEnd === -1) return // header not fully received yet

      const headerText = this.#buffer.toString('ascii', 0, headerEnd)
      const length = parseContentLength(headerText)
      if (length === null) {
        this.#onError(new Error(`dap: missing Content-Length in "${headerText}"`))
        // Drop the malformed header so we don't spin forever.
        this.#buffer = this.#buffer.subarray(headerEnd + HEADER_SEPARATOR.length)
        continue
      }

      const bodyStart = headerEnd + HEADER_SEPARATOR.length
      if (this.#buffer.length < bodyStart + length) return // body incomplete

      const body = this.#buffer.toString('utf8', bodyStart, bodyStart + length)
      this.#buffer = this.#buffer.subarray(bodyStart + length)

      try {
        this.#onMessage(JSON.parse(body) as DapMessage)
      } catch (err) {
        this.#onError(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }
}

/** Parse the `Content-Length` value from a header block, or null if absent. */
function parseContentLength(headerText: string): number | null {
  for (const line of headerText.split('\r\n')) {
    const match = /^Content-Length:\s*(\d+)$/i.exec(line.trim())
    if (match) return Number(match[1])
  }
  return null
}
