/**
 * LSP frame parser + writer tests — REQ-007.
 *
 * The renderer ↔ main bridge ships raw bytes; the renderer owns LSP
 * `Content-Length` framing. These tests pin the frame parser's behaviour
 * across the chunking variations a real stdout pipe applies:
 *
 *   - exact-frame chunks
 *   - mid-header splits
 *   - mid-body splits
 *   - multiple frames in one chunk
 *   - a partial frame followed by more bytes
 *
 * The `frameLspMessage` helper is round-tripped through the parser so
 * we know the writer's output is something the reader accepts.
 */

import { describe, expect, it } from 'vitest';

import { LspFrameParser, frameLspMessage } from './lspClient';

function chunk(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('frameLspMessage', () => {
  it('produces a Content-Length header and the JSON body', () => {
    const framed = frameLspMessage('{"jsonrpc":"2.0"}');
    const text = new TextDecoder().decode(framed);
    expect(text).toBe('Content-Length: 17\r\n\r\n{"jsonrpc":"2.0"}');
  });

  it('handles a UTF-8 multi-byte body length correctly', () => {
    const body = JSON.stringify({ s: 'café' });
    const framed = frameLspMessage(body);
    const text = new TextDecoder().decode(framed);
    // '{"s":"café"}' = 13 UTF-8 bytes (the `é` takes 2 bytes — c3 a9).
    expect(text.startsWith('Content-Length: 13\r\n\r\n')).toBe(true);
  });
});

describe('LspFrameParser', () => {
  it('parses a single complete frame in one chunk', () => {
    const parser = new LspFrameParser();
    const frame = frameLspMessage('{"a":1}');
    const frames = parser.feed(frame);
    expect(frames).toEqual(['{"a":1}']);
  });

  it('parses two frames in one chunk', () => {
    const parser = new LspFrameParser();
    const frame1 = frameLspMessage('{"a":1}');
    const frame2 = frameLspMessage('{"b":2}');
    const merged = new Uint8Array(frame1.byteLength + frame2.byteLength);
    merged.set(frame1, 0);
    merged.set(frame2, frame1.byteLength);
    expect(parser.feed(merged)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles a header split across chunks', () => {
    const parser = new LspFrameParser();
    expect(parser.feed(chunk('Content-Le'))).toEqual([]);
    expect(parser.feed(chunk('ngth: 7\r\n\r\n'))).toEqual([]);
    expect(parser.feed(chunk('{"a":1}'))).toEqual(['{"a":1}']);
  });

  it('handles a body split across chunks', () => {
    const parser = new LspFrameParser();
    expect(parser.feed(chunk('Content-Length: 7\r\n\r\n{"a"'))).toEqual([]);
    expect(parser.feed(chunk(':1}'))).toEqual(['{"a":1}']);
  });

  it('emits frames as they complete, even when more bytes are pending', () => {
    const parser = new LspFrameParser();
    const first = frameLspMessage('{"a":1}');
    const partialSecondHeader = new TextEncoder().encode('Content-Le');
    const buf = new Uint8Array(first.byteLength + partialSecondHeader.byteLength);
    buf.set(first, 0);
    buf.set(partialSecondHeader, first.byteLength);
    expect(parser.feed(buf)).toEqual(['{"a":1}']);
    // Subsequent chunks complete the second frame.
    expect(parser.feed(new TextEncoder().encode('ngth: 7\r\n\r\n{"b":2}'))).toEqual([
      '{"b":2}',
    ]);
  });

  it('round-trips a writer output through the parser', () => {
    const parser = new LspFrameParser();
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
    expect(parser.feed(frameLspMessage(body))).toEqual([body]);
  });

  it('survives a body containing the header delimiter', () => {
    const parser = new LspFrameParser();
    // Body that itself contains "\r\n\r\n" — the parser must NOT use a
    // global search after the first one in the buffer.
    const body = '{"s":"\\r\\n\\r\\n"}';
    expect(parser.feed(frameLspMessage(body))).toEqual([body]);
  });
});
