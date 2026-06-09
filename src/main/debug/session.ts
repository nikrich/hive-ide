/**
 * DAP debug session (E3-01).
 *
 * Owns one debug-adapter conversation: sequences requests, resolves their
 * responses, and forwards adapter *events* to a callback. The actual transport
 * (a spawned adapter's stdio) is injected as a {@link DapTransport} so the
 * session is unit-testable against a fake adapter without a child process.
 *
 * Uses the tested `dapCodec` for framing.
 */

import { DapMessageReader, encodeMessage, type DapMessage } from './dapCodec'

/** Abstract adapter transport — stdio in production, a loopback in tests. */
export interface DapTransport {
  /** Write a framed message to the adapter. */
  send(data: Buffer): void
  /** Subscribe to raw adapter output chunks. */
  onData(cb: (chunk: Buffer) => void): void
  /** Subscribe to adapter exit/close. */
  onClose(cb: () => void): void
  /** Terminate the transport. */
  dispose(): void
}

export interface DapResponse {
  success: boolean
  command: string
  message?: string
  body?: unknown
}

export interface DapEvent {
  event: string
  body?: unknown
}

/** Pending request awaiting its response, keyed by seq. */
interface Pending {
  resolve: (r: DapResponse) => void
  reject: (e: Error) => void
}

export class DebugSession {
  #transport: DapTransport
  #reader: DapMessageReader
  #seq = 1
  #pending = new Map<number, Pending>()
  #onEvent: (event: DapEvent) => void
  #closed = false

  constructor(transport: DapTransport, onEvent: (event: DapEvent) => void) {
    this.#transport = transport
    this.#onEvent = onEvent
    this.#reader = new DapMessageReader(
      (msg) => this.#handleMessage(msg),
      () => undefined,
    )
    transport.onData((chunk) => this.#reader.push(chunk))
    transport.onClose(() => this.#handleClose())
  }

  /** Send a request and resolve with its response. */
  request(command: string, args?: unknown): Promise<DapResponse> {
    if (this.#closed) return Promise.reject(new Error('dap: session closed'))
    const seq = this.#seq++
    const message: DapMessage = {
      seq,
      type: 'request',
      command,
      ...(args !== undefined ? { arguments: args } : {}),
    }
    return new Promise<DapResponse>((resolve, reject) => {
      this.#pending.set(seq, { resolve, reject })
      this.#transport.send(encodeMessage(message))
    })
  }

  #handleMessage(msg: DapMessage): void {
    const type = msg.type
    if (type === 'response') {
      const reqSeq = Number(msg.request_seq)
      const pending = this.#pending.get(reqSeq)
      if (pending) {
        this.#pending.delete(reqSeq)
        pending.resolve({
          success: msg.success === true,
          command: String(msg.command ?? ''),
          message: typeof msg.message === 'string' ? msg.message : undefined,
          body: msg.body,
        })
      }
    } else if (type === 'event') {
      this.#onEvent({
        event: String(msg.event ?? ''),
        body: msg.body,
      })
    }
    // 'request' (reverse requests like runInTerminal) are acknowledged by the
    // caller layer when needed; v1 ignores them.
  }

  #handleClose(): void {
    if (this.#closed) return
    this.#closed = true
    for (const p of this.#pending.values()) {
      p.reject(new Error('dap: adapter closed'))
    }
    this.#pending.clear()
    this.#onEvent({ event: 'terminated' })
  }

  dispose(): void {
    if (this.#closed) return
    this.#closed = true
    this.#pending.clear()
    this.#transport.dispose()
  }
}
