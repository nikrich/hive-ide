/**
 * Search engine tests (E2-01) — exercised against a real temp directory.
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listFiles, searchFiles } from './engine'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'hive-search-'))
  await fs.writeFile(join(root, 'a.ts'), 'const foo = 1\nconst bar = foo + 2\n')
  await fs.writeFile(join(root, 'b.txt'), 'nothing here\n')
  await fs.mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await fs.writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'foo foo foo\n')
  await fs.mkdir(join(root, 'sub'), { recursive: true })
  await fs.writeFile(join(root, 'sub', 'c.ts'), 'let FOO = 3\n')
  // A binary file with a NUL byte — must be skipped.
  await fs.writeFile(join(root, 'bin.dat'), Buffer.from([0x66, 0x00, 0x6f]))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('searchFiles', () => {
  it('finds matches grouped by file, skipping excluded dirs', async () => {
    const res = await searchFiles({
      roots: [root],
      query: 'foo',
      exclude: ['**/node_modules'],
    })
    const files = res.results.map((r) => r.file.replace(root, '').replace(/^[/\\]/, ''))
    expect(files).toContain('a.ts')
    // node_modules excluded, b.txt has no match
    expect(files.some((f) => f.includes('node_modules'))).toBe(false)
    const a = res.results.find((r) => r.file.endsWith('a.ts'))
    expect(a?.matches[0]).toMatchObject({ line: 1 })
    expect(res.total).toBeGreaterThan(0)
  })

  it('is case-insensitive by default and case-sensitive on request', async () => {
    const ci = await searchFiles({ roots: [root], query: 'foo', exclude: ['**/node_modules'] })
    expect(ci.results.some((r) => r.file.endsWith('c.ts'))).toBe(true)
    const cs = await searchFiles({
      roots: [root],
      query: 'foo',
      options: { caseSensitive: true },
      exclude: ['**/node_modules'],
    })
    expect(cs.results.some((r) => r.file.endsWith('c.ts'))).toBe(false)
  })

  it('skips binary files', async () => {
    const res = await searchFiles({ roots: [root], query: 'fo' })
    expect(res.results.some((r) => r.file.endsWith('bin.dat'))).toBe(false)
  })

  it('returns empty for an empty query', async () => {
    const res = await searchFiles({ roots: [root], query: '' })
    expect(res.results).toEqual([])
    expect(res.total).toBe(0)
  })

  it('reports truncation when the result cap is hit', async () => {
    const res = await searchFiles({
      roots: [root],
      query: 'o',
      maxResults: 1,
      exclude: ['**/node_modules'],
    })
    expect(res.truncated).toBe(true)
  })
})

describe('listFiles', () => {
  it('lists files under roots, skipping excludes', async () => {
    const { files } = await listFiles({ roots: [root], exclude: ['**/node_modules'] })
    const rel = files.map((f) => f.replace(root, '').replace(/^[/\\]/, ''))
    expect(rel).toContain('a.ts')
    expect(rel).toContain(['sub', 'c.ts'].join(sep))
    expect(rel.some((f) => f.includes('node_modules'))).toBe(false)
  })
})
