/**
 * DAP codec tests (E3-01).
 */

import { describe, expect, it, vi } from 'vitest'

import { DapMessageReader, encodeMessage } from './dapCodec'

describe('encodeMessage', () => {
  it('frames a message with a Content-Length header', () => {
    const buf = encodeMessage({ seq: 1, type: 'request', command: 'initialize' })
    const text = buf.toString('utf8')
    expect(text).toMatch(/^Content-Length: \d+\r\n\r\n/)
    const body = text.slice(text.indexOf('\r\n\r\n') + 4)
    expect(JSON.parse(body)).toMatchObject({ command: 'initialize' })
  })

  it('round-trips through the reader', () => {
    const messages: unknown[] = []
    const reader = new DapMessageReader((m) => messages.push(m))
    reader.push(encodeMessage({ seq: 1, type: 'event', event: 'stopped' }))
    expect(messages).toEqual([{ seq: 1, type: 'event', event: 'stopped' }])
  })
})

describe('DapMessageReader', () => {
  it('handles a message split across multiple chunks', () => {
    const messages: unknown[] = []
    const reader = new DapMessageReader((m) => messages.push(m))
    const full = encodeMessage({ seq: 2, type: 'response', command: 'next' })
    reader.push(full.subarray(0, 10))
    reader.push(full.subarray(10, 25))
    expect(messages).toHaveLength(0)
    reader.push(full.subarray(25))
    expect(messages).toHaveLength(1)
  })

  it('emits multiple messages coalesced into one chunk', () => {
    const messages: unknown[] = []
    const reader = new DapMessageReader((m) => messages.push(m))
    const a = encodeMessage({ seq: 1, type: 'event', event: 'a' })
    const b = encodeMessage({ seq: 2, type: 'event', event: 'b' })
    reader.push(Buffer.concat([a, b]))
    expect(messages).toHaveLength(2)
  })

  it('reports a parse error on malformed JSON without crashing', () => {
    const onError = vi.fn()
    const reader = new DapMessageReader(() => undefined, onError)
    const bad = Buffer.from('Content-Length: 3\r\n\r\n{x}', 'utf8')
    reader.push(bad)
    expect(onError).toHaveBeenCalled()
  })
})
