/**
 * When-clause evaluator (E6-05).
 *
 * VSCode gates commands + keybindings behind "when" expressions evaluated
 * against a bag of context keys (e.g. `editorFocus && hasGitRepo`,
 * `!debugging`, `view == 'ide'`). This module is a small, dependency-free
 * evaluator for that grammar:
 *
 *   expr    := or
 *   or      := and ('||' and)*
 *   and     := unary ('&&' unary)*
 *   unary   := '!' unary | comparison
 *   compare := primary (('==' | '!=') primary)?
 *   primary := '(' expr ')' | literal | identifier
 *   literal := 'true' | 'false' | number | 'single-quoted string'
 *
 * Identifiers resolve against the {@link WhenContext}. A bare identifier is
 * truthy-tested; `key == 'value'` compares the context value to a literal.
 * Unknown identifiers read as `undefined` (falsy), matching VSCode.
 *
 * Deliberately NOT a general expression language — no arithmetic, no function
 * calls, no member access. That keeps it safe to run on registry-supplied
 * strings without `eval`.
 */

export type WhenValue = boolean | string | number | undefined

export type WhenContext = Readonly<Record<string, WhenValue>>

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'op'; value: '&&' | '||' | '!' | '==' | '!=' | '(' | ')' }
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = input.length
  while (i < n) {
    const c = input[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '&' && input[i + 1] === '&') {
      tokens.push({ kind: 'op', value: '&&' })
      i += 2
      continue
    }
    if (c === '|' && input[i + 1] === '|') {
      tokens.push({ kind: 'op', value: '||' })
      i += 2
      continue
    }
    if (c === '=' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '==' })
      i += 2
      continue
    }
    if (c === '!' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '!=' })
      i += 2
      continue
    }
    if (c === '!') {
      tokens.push({ kind: 'op', value: '!' })
      i++
      continue
    }
    if (c === '(') {
      tokens.push({ kind: 'op', value: '(' })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ kind: 'op', value: ')' })
      i++
      continue
    }
    if (c === "'") {
      let j = i + 1
      let str = ''
      while (j < n && input[j] !== "'") {
        str += input[j]
        j++
      }
      if (j >= n) throw new Error(`when: unterminated string in "${input}"`)
      tokens.push({ kind: 'string', value: str })
      i = j + 1
      continue
    }
    // identifier / number / keyword
    if (/[A-Za-z0-9_.\-]/.test(c)) {
      let j = i
      let word = ''
      while (j < n && /[A-Za-z0-9_.\-]/.test(input[j])) {
        word += input[j]
        j++
      }
      i = j
      if (word === 'true') tokens.push({ kind: 'bool', value: true })
      else if (word === 'false') tokens.push({ kind: 'bool', value: false })
      else if (/^-?\d+(\.\d+)?$/.test(word))
        tokens.push({ kind: 'number', value: Number(word) })
      else tokens.push({ kind: 'ident', value: word })
      continue
    }
    throw new Error(`when: unexpected character "${c}" in "${input}"`)
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Parser → AST
// ---------------------------------------------------------------------------

type Node =
  | { type: 'or'; left: Node; right: Node }
  | { type: 'and'; left: Node; right: Node }
  | { type: 'not'; operand: Node }
  | { type: 'eq'; left: Node; right: Node; negate: boolean }
  | { type: 'ident'; name: string }
  | { type: 'lit'; value: WhenValue }

class Parser {
  #tokens: Token[]
  #pos = 0
  constructor(tokens: Token[]) {
    this.#tokens = tokens
  }
  #peek(): Token | undefined {
    return this.#tokens[this.#pos]
  }
  #isOp(value: string): boolean {
    const t = this.#peek()
    return t !== undefined && t.kind === 'op' && t.value === value
  }
  #consumeOp(value: string): void {
    if (!this.#isOp(value)) throw new Error(`when: expected "${value}"`)
    this.#pos++
  }

  parse(): Node {
    const node = this.#or()
    if (this.#pos !== this.#tokens.length) {
      throw new Error('when: trailing tokens')
    }
    return node
  }

  #or(): Node {
    let left = this.#and()
    while (this.#isOp('||')) {
      this.#pos++
      left = { type: 'or', left, right: this.#and() }
    }
    return left
  }

  #and(): Node {
    let left = this.#unary()
    while (this.#isOp('&&')) {
      this.#pos++
      left = { type: 'and', left, right: this.#unary() }
    }
    return left
  }

  #unary(): Node {
    if (this.#isOp('!')) {
      this.#pos++
      return { type: 'not', operand: this.#unary() }
    }
    return this.#comparison()
  }

  #comparison(): Node {
    const left = this.#primary()
    if (this.#isOp('==') || this.#isOp('!=')) {
      const negate = this.#isOp('!=')
      this.#pos++
      const right = this.#primary()
      return { type: 'eq', left, right, negate }
    }
    return left
  }

  #primary(): Node {
    const t = this.#peek()
    if (t === undefined) throw new Error('when: unexpected end of input')
    if (t.kind === 'op' && t.value === '(') {
      this.#consumeOp('(')
      const node = this.#or()
      this.#consumeOp(')')
      return node
    }
    if (t.kind === 'ident') {
      this.#pos++
      return { type: 'ident', name: t.value }
    }
    if (t.kind === 'string' || t.kind === 'number' || t.kind === 'bool') {
      this.#pos++
      return { type: 'lit', value: t.value }
    }
    throw new Error(`when: unexpected token "${t.value}"`)
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function resolve(node: Node, ctx: WhenContext): WhenValue {
  switch (node.type) {
    case 'lit':
      return node.value
    case 'ident':
      return ctx[node.name]
    case 'not':
      return !truthy(resolve(node.operand, ctx))
    case 'and':
      return truthy(resolve(node.left, ctx)) && truthy(resolve(node.right, ctx))
    case 'or':
      return truthy(resolve(node.left, ctx)) || truthy(resolve(node.right, ctx))
    case 'eq': {
      const l = resolve(node.left, ctx)
      const r = resolve(node.right, ctx)
      const equal = l === r
      return node.negate ? !equal : equal
    }
  }
}

function truthy(v: WhenValue): boolean {
  return v !== undefined && v !== false && v !== '' && v !== 0
}

// Tiny memo so re-evaluating the same clause across many keystrokes / palette
// renders doesn't re-tokenize+parse each time.
const astCache = new Map<string, Node>()

/**
 * Evaluate a when-clause against a context. An empty / undefined clause is
 * always true (an unconditional command). A malformed clause evaluates to
 * `false` and logs — a bad registry entry should hide a command, not crash.
 */
export function evaluateWhen(
  clause: string | undefined,
  ctx: WhenContext,
): boolean {
  if (clause === undefined) return true
  const trimmed = clause.trim()
  if (trimmed === '') return true
  try {
    let ast = astCache.get(trimmed)
    if (ast === undefined) {
      ast = new Parser(tokenize(trimmed)).parse()
      astCache.set(trimmed, ast)
    }
    return truthy(resolve(ast, ctx))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`when: failed to evaluate "${clause}"`, err)
    return false
  }
}
