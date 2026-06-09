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
  buildReplaceRegExp,
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
  /** Lines of context to include before/after each match (E2-10). Default 0. */
  contextLines?: number
}

export interface LineMatchResult {
  /** 1-based line number. */
  line: number
  /** The full line text (trimmed of trailing newline). */
  preview: string
  /** Match ranges (0-based columns) within `preview`. */
  ranges: MatchRange[]
  /** Context lines before the match (E2-10), nearest last. */
  before?: string[]
  /** Context lines after the match (E2-10), nearest first. */
  after?: string[]
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
    const ctx = req.contextLines ?? 0
    const fileMatches: LineMatchResult[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '')
      const ranges = matcher(line)
      if (ranges.length === 0) continue
      const match: LineMatchResult = {
        line: i + 1,
        // Cap preview length so a minified line can't blow up the payload.
        preview: line.length > 1000 ? line.slice(0, 1000) : line,
        ranges,
      }
      if (ctx > 0) {
        match.before = lines
          .slice(Math.max(0, i - ctx), i)
          .map((l) => l.replace(/\r$/, '').slice(0, 1000))
        match.after = lines
          .slice(i + 1, i + 1 + ctx)
          .map((l) => l.replace(/\r$/, '').slice(0, 1000))
      }
      fileMatches.push(match)
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

export interface ReplaceRequest {
  /** Files to apply the replacement in (absolute paths). */
  files: string[]
  query: string
  replacement: string
  options?: SearchOptions
  /**
   * Per-file 1-based line numbers to SKIP (per-match opt-out, E2-04).
   * Files without an entry are replaced whole-file as before.
   */
  excludeLines?: Record<string, number[]>
}

export interface ReplaceResponse {
  filesChanged: number
  replacements: number
}

/**
 * Apply a find/replace across the given files (E2-04). In literal mode the
 * replacement is inserted verbatim ($ has no special meaning); in regex mode
 * `$1` backreferences work. Only files whose content actually changes are
 * written. Binary files are skipped defensively. When `excludeLines` is
 * supplied, lines whose 1-based number appears in the per-file set are left
 * untouched (line-exclusion mode, E2-04 per-match opt-out).
 */
export async function replaceInFiles(req: ReplaceRequest): Promise<ReplaceResponse> {
  if (req.query === '') return { filesChanged: 0, replacements: 0 }
  const useRegex = req.options?.regex === true
  let filesChanged = 0
  let replacements = 0

  for (const file of req.files) {
    let buf: Buffer
    try {
      buf = await fs.readFile(file)
    } catch {
      continue
    }
    if (looksBinary(buf)) continue
    const excluded = req.excludeLines?.[file]
    const text = buf.toString('utf8')
    const re = buildReplaceRegExp(req.query, req.options)
    let next: string
    let count = 0
    if (excluded !== undefined && excluded.length > 0) {
      // Line-exclusion mode: replace line-by-line, skipping excluded lines.
      // Search matches are found per-line, so per-line replacement is
      // consistent with what the results pane showed.
      const skip = new Set(excluded)
      const lines = text.split('\n')
      next = lines
        .map((lineText, i) => {
          if (skip.has(i + 1)) return lineText
          re.lastIndex = 0
          const found = lineText.match(re)
          if (found === null) return lineText
          count += found.length
          re.lastIndex = 0
          return useRegex
            ? lineText.replace(re, req.replacement)
            : lineText.replace(re, () => req.replacement)
        })
        .join('\n')
    } else {
      const found = text.match(re)
      count = found ? found.length : 0
      if (count === 0) continue
      // Regex mode: String.replace expands $1 backreferences from the template.
      // Literal mode: a function replacer inserts the replacement verbatim so a
      // literal '$' isn't treated as a backreference.
      next = useRegex
        ? text.replace(re, req.replacement)
        : text.replace(re, () => req.replacement)
    }
    if (count > 0 && next !== text) {
      await fs.writeFile(file, next, 'utf8')
      filesChanged++
      replacements += count
    }
  }

  return { filesChanged, replacements }
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
