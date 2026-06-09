/**
 * DAP session tests (E3-01) — driven by a fake loopback adapter.
 */

import { describe, expect, it, vi } from 'vitest'

import { DapMessageReader, encodeMessage } from './dapCodec'
import { DebugSession, type DapEvent, type DapTransport } from './session'

/**
 * A fake adapter transport: captures requests the session sends (via a
 * DapMessageReader) and lets the test push framed responses/events back.
 */
function fakeTransport(): {
  transport: DapTransport
  onRequest: (cb: (msg: Record<string, unknown>) => void) => void
  push: (msg: Record<string, unknown>) => void
  close: () => void
} {
  let dataCb: ((c: Buffer) => void) | null = null
  let closeCb: (() => void) | null = null
  let reqCb: ((m: Record<string, unknown>) => void) | null = null
  const reader = new DapMessageReader((m) => reqCb?.(m as Record<string, unknown>))
  return {
    transport: {
      send: (data) => reader.push(data),
      onData: (cb) => {
        dataCb = cb
      },
      onClose: (cb) => {
        closeCb = cb
      },
      dispose: () => undefined,
    },
    onRequest: (cb) => {
      reqCb = cb
    },
    push: (msg) => dataCb?.(encodeMessage(msg)),
    close: () => closeCb?.(),
  }
}

describe('DebugSession', () => {
  it('resolves a request with its matching response', async () => {
    const fake = fakeTransport()
    const session = new DebugSession(fake.transport, () => undefined)
    fake.onRequest((req) => {
      // Echo a successful response for the request's seq.
      fake.push({
        type: 'response',
        request_seq: req.seq,
        success: true,
        command: req.command,
        body: { ok: 1 },
      })
    })
    const res = await session.request('initialize', { clientID: 'hive' })
    expect(res.success).toBe(true)
    expect(res.command).toBe('initialize')
    expect(res.body).toEqual({ ok: 1 })
  })

  it('forwards adapter events to the callback', () => {
    const fake = fakeTransport()
    const events: DapEvent[] = []
    new DebugSession(fake.transport, (e) => events.push(e))
    fake.push({ type: 'event', event: 'stopped', body: { reason: 'breakpoint' } })
    expect(events).toEqual([{ event: 'stopped', body: { reason: 'breakpoint' } }])
  })

  it('rejects pending requests and emits terminated on close', async () => {
    const fake = fakeTransport()
    const events: DapEvent[] = []
    const session = new DebugSession(fake.transport, (e) => events.push(e))
    const pending = session.request('configurationDone')
    fake.close()
    await expect(pending).rejects.toThrow(/closed/)
    expect(events.some((e) => e.event === 'terminated')).toBe(true)
  })

  it('rejects requests after dispose', async () => {
    const fake = fakeTransport()
    const dispose = vi.fn()
    const session = new DebugSession(
      { ...fake.transport, dispose },
      () => undefined,
    )
    session.dispose()
    expect(dispose).toHaveBeenCalled()
    await expect(session.request('next')).rejects.toThrow(/closed/)
  })
})
