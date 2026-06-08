/**
 * Filesystem search engine (E2-01).
 *
 * Walks a set of root directories and either:
 *   - {@link searchFiles}: scans text file contents for a query, returning
 *     matches grouped by file (content search — global find), or
 *   - {@link listFiles}: returns the file paths under the roots (quick-open
 *     index — E2-03).
 *
 * Both skip an exclude list (glob matched against the path relative to its
 * root) and binary-looking files. Results are bounded by a cap so a huge tree
 * can't exhaust memory; the caller is told when truncation happened.
 *
 * This is a dependency-free Node implementation. It intentionally does NOT
 * shell out to ripgrep — keeping the binary off the dependency path — at the
 * cost of not honouring nested `.gitignore` rules beyond the configured
 * exclude globs.
 */

import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'

import {
  buildMatcher,
  looksBinary,
  matchesAnyGlob,
  type MatchRange,
  type SearchOptions,
} from './match'

/** Default directory/file globs always excluded, merged with caller globs. */
const ALWAYS_EXCLUDE = ['**/.git']

export interface SearchRequest {
  /** Absolute root directories to search (the project's repos). */
  roots: string[]
  query: string
  options?: SearchOptions
  /** Glob patterns to skip (relative to each root). */
  exclude?: string[]
  /** Max total matches before truncating. Default 5000. */
  maxResults?: number
  /** Max files to open. Default 20000. */
  maxFiles?: number
}

export interface LineMatchResult {
  /** 1-based line number. */
  line: number
  /** The full line text (trimmed of trailing newline). */
  preview: string
  /** Match ranges (0-based columns) within `preview`. */
  ranges: MatchRange[]
}

export interface FileMatchResult {
  /** Absolute file path. */
  file: string
  matches: LineMatchResult[]
}

export interface SearchResponse {
  results: FileMatchResult[]
  /** True when the result/file cap was hit before the walk finished. */
  truncated: boolean
  /** Total match count across all files. */
  total: number
}

/** Yields absolute file paths under `roots`, skipping excluded entries. */
async function* walk(
  roots: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const allExclude = [...ALWAYS_EXCLUDE, ...exclude]
  for (const root of roots) {
    const stack: string[] = [root]
    while (stack.length > 0) {
      if (signal?.aborted) return
      const dir = stack.pop() as string
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        const rel = relative(root, full).split(sep).join('/')
        if (matchesAnyGlob(rel, allExclude)) continue
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile()) {
          yield full
        }
      }
    }
  }
}

/** Search file contents across roots for `query`. */
export async function searchFiles(req: SearchRequest): Promise<SearchResponse> {
  const matcher = buildMatcher(req.query, req.options)
  const maxResults = req.maxResults ?? 5000
  const maxFiles = req.maxFiles ?? 20000
  const exclude = req.exclude ?? []
  const results: FileMatchResult[] = []
  let total = 0
  let filesSeen = 0
  let truncated = false

  if (req.query === '') return { results, truncated: false, total: 0 }

  for await (const file of walk(req.roots, exclude)) {
    if (filesSeen >= maxFiles) {
      truncated = true
      break
    }
    filesSeen++
    let buf: Buffer
    try {
      buf = await fs.readFile(file)
    } catch {
      continue
    }
    if (looksBinary(buf)) continue
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    const fileMatches: LineMatchResult[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '')
      const ranges = matcher(line)
      if (ranges.length === 0) continue
      fileMatches.push({
        line: i + 1,
        // Cap preview length so a minified line can't blow up the payload.
        preview: line.length > 1000 ? line.slice(0, 1000) : line,
        ranges,
      })
      total += ranges.length
      if (total >= maxResults) {
        truncated = true
        break
      }
    }
    if (fileMatches.length > 0) results.push({ file, matches: fileMatches })
    if (truncated) break
  }

  return { results, truncated, total }
}

export interface ListFilesRequest {
  roots: string[]
  exclude?: string[]
  /** Max files returned. Default 20000. */
  max?: number
}

/** List file paths under roots for the quick-open index. */
export async function listFiles(req: ListFilesRequest): Promise<{
  files: string[]
  truncated: boolean
}> {
  const max = req.max ?? 20000
  const files: string[] = []
  let truncated = false
  for await (const file of walk(req.roots, req.exclude ?? [])) {
    if (files.length >= max) {
      truncated = true
      break
    }
    files.push(file)
  }
  return { files, truncated }
}
