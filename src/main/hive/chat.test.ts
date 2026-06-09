import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendChatMessage } from './chat'

let ws: string

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'hive-chat-'))
  await mkdir(join(ws, '.hive'), { recursive: true })
})

afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('appendChatMessage', () => {
  it('appends one ndjson line per call', async () => {
    await appendChatMessage(ws, 'first', new Date('2026-06-09T10:00:00Z'))
    await appendChatMessage(ws, 'second', new Date('2026-06-09T10:01:00Z'))
    const lines = (await readFile(join(ws, '.hive', 'chat.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { ts: '2026-06-09T10:00:00.000Z', who: 'you', txt: 'first' },
      { ts: '2026-06-09T10:01:00.000Z', who: 'you', txt: 'second' },
    ])
  })

  it('rejects empty messages', async () => {
    await expect(appendChatMessage(ws, '   ')).rejects.toThrow(/empty/i)
  })
})
