/**
 * Hive IDE — lightweight syntax highlighter.
 *
 * Pure ES-module port of the original `design-reference/highlight.js` IIFE.
 * `highlightCode(text, lang)` returns an HTML string of escaped, span-wrapped
 * tokens. Safe to call on every keystroke: single-pass scanners, no external
 * deps, no DOM access.
 *
 * Supported `lang` values:
 *   - "ts" / "js" / "tsx" / "json" / "css"  -> generic c-like tokenizer
 *   - "md"                                  -> markdown (line-based) tokenizer
 *   - anything else                         -> falls through to the c-like tokenizer
 *
 * Token classes emitted:
 *   t-key, t-str, t-com, t-num, t-fn, t-type, t-var, t-punct, t-op, t-md-h, t-md-b
 */

const KEYWORDS: ReadonlySet<string> = new Set([
  'import', 'from', 'export', 'default', 'const', 'let', 'var', 'function', 'return',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new',
  'class', 'extends', 'implements', 'interface', 'type', 'enum', 'namespace',
  'public', 'private', 'protected', 'readonly', 'static', 'abstract',
  'async', 'await', 'yield', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof',
  'in', 'of', 'as', 'is', 'keyof', 'void', 'null', 'undefined', 'true', 'false',
  'this', 'super', 'get', 'set', 'delete', 'Promise'
])

const TYPES: ReadonlySet<string> = new Set([
  'string', 'number', 'boolean', 'object', 'unknown', 'any', 'never', 'bigint', 'symbol',
  'Array', 'Record', 'Partial', 'ReactNode', 'RequestInit'
])

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => HTML_ESCAPES[c] ?? c)
}

function span(cls: string, s: string): string {
  return '<span class="' + cls + '">' + esc(s) + '</span>'
}

const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c)
const isId = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)

/** Generic c-like tokenizer used for ts / js / tsx / json / css. */
function tokenizeCode(src: string): string {
  let out = ''
  let i = 0
  const n = src.length

  while (i < n) {
    const c = src[i]!

    // whitespace / newline — pass through raw
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      out += c
      i++
      continue
    }

    // line comment
    if (c === '/' && src[i + 1] === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      out += span('t-com', src.slice(i, j))
      i = j
      continue
    }

    // block comment
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      j = Math.min(n, j + 2)
      out += span('t-com', src.slice(i, j))
      i = j
      continue
    }

    // strings (', ", `) — handles escaped quotes
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++
        j++
      }
      j = Math.min(n, j + 1)
      out += span('t-str', src.slice(i, j))
      i = j
      continue
    }

    // numbers (incl. leading-dot like .5, hex like 0xFF, separators _)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i
      while (j < n && /[0-9a-fxA-FX._]/.test(src[j]!)) j++
      out += span('t-num', src.slice(i, j))
      i = j
      continue
    }

    // identifiers / keywords / types / functions / vars
    if (isIdStart(c)) {
      let j = i
      while (j < n && isId(src[j]!)) j++
      const word = src.slice(i, j)
      // look ahead past spaces for "(" => function call
      let k = j
      while (k < n && src[k] === ' ') k++
      const isCall = src[k] === '('
      if (KEYWORDS.has(word)) out += span('t-key', word)
      else if (TYPES.has(word) || /^[A-Z]/.test(word)) out += span('t-type', word)
      else if (isCall) out += span('t-fn', word)
      else out += span('t-var', word)
      i = j
      continue
    }

    // punctuation
    if ('{}()[];,.:'.includes(c)) {
      out += span('t-punct', c)
      i++
      continue
    }

    // operators
    if ('=+-*/%<>!&|?^~'.includes(c)) {
      out += span('t-op', c)
      i++
      continue
    }

    // anything else — pass through escaped
    out += esc(c)
    i++
  }

  return out
}

/** Markdown inline pass — bold, inline code, links. */
function inlineMd(s: string): string {
  // escape first, then re-introduce a couple of safe spans on the escaped text
  let e = esc(s)
  e = e.replace(/(\*\*[^*]+\*\*)/g, '<span class="t-md-b">$1</span>')
  e = e.replace(/(`[^`]+`)/g, '<span class="t-str">$1</span>')
  e = e.replace(/(\[[^\]]+\]\([^)]+\))/g, '<span class="t-fn">$1</span>')
  return e
}

/** Markdown line-based tokenizer — headers, lists, fenced blocks, inline pass. */
function tokenizeMd(src: string): string {
  const lines = src.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^```/.test(line)) {
        inFence = !inFence
        return span('t-com', line)
      }
      if (inFence) return span('t-str', line)
      if (/^#{1,6}\s/.test(line)) return span('t-md-h', line)
      if (/^\s*[-*]\s/.test(line)) {
        return line.replace(/^(\s*[-*]\s)(.*)$/, (_m, b: string, rest: string) =>
          span('t-op', b) + inlineMd(rest)
        )
      }
      return inlineMd(line)
    })
    .join('\n')
}

/**
 * Highlight `text` as `lang`, returning an HTML string of escaped, span-wrapped
 * tokens. Pure: no DOM, no I/O, no module state mutated between calls.
 *
 * Falls back to plain escaped text on any internal failure so callers can
 * always trust the output to be safe to inject as `innerHTML`.
 */
export function highlightCode(text: string, lang: string): string {
  if (text == null) return ''
  try {
    if (lang === 'md') return tokenizeMd(text)
    return tokenizeCode(text)
  } catch {
    return esc(text)
  }
}
