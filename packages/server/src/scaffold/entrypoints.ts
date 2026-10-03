import { BreadError } from '@breadai/core'
import { assertAgentId } from './names.js'

interface Quoted {
  value: string
  quote: "'" | '"'
  start: number
  end: number
}

// Only a plain quoted-string array is safe to edit by hand. A spread, name,
// or comment needs a real parse — a wrong edit is worse than refusing.
function uneditable(id: string): BreadError {
  return new BreadError(
    `Cannot edit entrypoints to add "${id}". The list must be a plain array of quoted strings. Add "${id}" by hand.`,
    'ENTRYPOINTS_UNEDITABLE',
    { id },
  )
}

// Comments and strings are not the array. '-' is an identifier character, so
// `my-entrypoints` is not a second `entrypoints` key.
const IDENT = /[A-Za-z0-9_-]/

function isIdent(ch: string | undefined): boolean {
  return ch !== undefined && IDENT.test(ch)
}

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

type BraceKind = 'value' | 'type' | 'other'

interface ScanCtx {
  braces: BraceKind[]
}

interface CodeToken {
  index: number
  punct?: string
  word?: string
}

function findEntrypointColons(source: string, id: string): number[] {
  const hits: number[] = []
  scanCode(source, 0, source.length, hits, null, id, { braces: [] })
  return hits
}

function scanCode(
  source: string,
  start: number,
  end: number,
  hits: number[],
  stopBrace: number | null,
  id: string,
  ctx: ScanCtx,
): number {
  const key = 'entrypoints'
  let i = start
  let depth = stopBrace
  while (i < end) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/' && i + 1 < end) {
      i += 2
      while (i < end && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*' && i + 1 < end) {
      i += 2
      while (i < end && !(source[i] === '*' && source[i + 1] === '/')) i++
      i = Math.min(end, i + 2)
      continue
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(source, i, end, ch)
      continue
    }
    if (ch === '`') {
      i = skipTemplate(source, i, end, hits, id, ctx)
      continue
    }
    // A regexp or division is not a comment. `$` joins an identifier
    // (`foo$entrypoints`). Either one is not a plain list we can edit.
    if (ch === '/') throw uneditable(id)
    if (ch === '$' && (isIdent(i === 0 ? undefined : source[i - 1]) || isIdent(source[i + 1]))) {
      throw uneditable(id)
    }
    if (ch === '{') {
      ctx.braces.push(openBraceKind(source, i, ctx))
      if (depth !== null) depth++
      i++
      continue
    }
    if (ch === '}') {
      if (depth !== null) {
        depth--
        i++
        if (depth === 0) return i
        ctx.braces.pop()
        continue
      }
      ctx.braces.pop()
      i++
      continue
    }
    if (
      i + key.length <= end &&
      source.startsWith(key, i) &&
      !isIdent(i === 0 ? undefined : source[i - 1]) &&
      !isIdent(source[i + key.length])
    ) {
      let j = i + key.length
      while (j < end && isWs(source[j])) j++
      if (j < end && source[j] === ':' && ctx.braces[ctx.braces.length - 1] === 'value') hits.push(j)
      i += key.length
      continue
    }
    i++
  }
  return i
}

function skipQuoted(source: string, i: number, end: number, quote: string): number {
  i++
  while (i < end) {
    if (source[i] === '\\') {
      i += 2
      continue
    }
    if (source[i] === quote) return i + 1
    if (source[i] === '\n') return i
    i++
  }
  return i
}

function skipTemplate(source: string, i: number, end: number, hits: number[], id: string, ctx: ScanCtx): number {
  i++
  while (i < end) {
    if (source[i] === '\\') {
      i += 2
      continue
    }
    if (source[i] === '`') return i + 1
    if (source[i] === '$' && source[i + 1] === '{') {
      i = scanCode(source, i + 2, end, hits, 1, id, ctx)
      continue
    }
    i++
  }
  return i
}

const VALUE_BRACE_WORDS = new Set(['return', 'default', 'yield'])

// Only an object-literal property is the runtime list. A type alias,
// interface, or annotation uses the same colon and must not be edited.
function openBraceKind(source: string, brace: number, ctx: ScanCtx): BraceKind {
  const prev = previousToken(source, brace)
  if (!prev) return 'other'
  if (prev.punct === '(' || prev.punct === '[' || prev.punct === ',') return 'value'
  if (prev.punct === '=') return equalsIsTypeAlias(source, prev.index) ? 'type' : 'value'
  if (prev.punct === ':') return ctx.braces[ctx.braces.length - 1] === 'value' ? 'value' : 'type'
  if (prev.word !== undefined && VALUE_BRACE_WORDS.has(prev.word)) return 'value'
  if (isInterfaceOpen(source, prev)) return 'type'
  return 'other'
}

function equalsIsTypeAlias(source: string, eqIndex: number): boolean {
  let i = skipTriviaBack(source, eqIndex - 1)
  if (i >= 0 && source[i] === '>') i = skipGenericsBack(source, i)
  if (i < 0 || !isIdent(source[i])) return false
  while (i > 0 && isIdent(source[i - 1])) i--
  return previousToken(source, i)?.word === 'type'
}

function isInterfaceOpen(source: string, prev: CodeToken): boolean {
  const name = nameIntroducingBrace(source, prev)
  if (!name) return false
  return previousToken(source, name.index)?.word === 'interface'
}

function nameIntroducingBrace(source: string, prev: CodeToken): CodeToken | null {
  if (prev.word) return prev
  if (prev.punct !== '>') return null
  const before = skipGenericsBack(source, prev.index)
  return before < 0 ? null : previousToken(source, before + 1)
}

function skipGenericsBack(source: string, gtIndex: number): number {
  let i = gtIndex - 1
  let depth = 1
  while (i >= 0 && depth > 0) {
    const ch = source[i]
    if (ch === '>') depth++
    else if (ch === '<') depth--
    i--
  }
  return skipTriviaBack(source, i)
}

function previousToken(source: string, index: number): CodeToken | null {
  const i = skipTriviaBack(source, index - 1)
  if (i < 0) return null
  const ch = source[i]
  if (ch === undefined) return null
  if (isIdent(ch)) {
    let start = i
    while (start > 0 && isIdent(source[start - 1])) start--
    return { index: start, word: source.slice(start, i + 1) }
  }
  return { index: i, punct: ch }
}

function skipTriviaBack(source: string, i: number): number {
  while (i >= 0) {
    const ch = source[i]
    if (ch === undefined) return -1
    if (isWs(ch)) {
      i--
      continue
    }
    if (ch === '/' && source[i - 1] === '*') {
      i -= 2
      while (i >= 0 && !(source[i] === '/' && source[i + 1] === '*')) i--
      i--
      continue
    }
    const comment = lineCommentStart(source, i)
    if (comment !== null && comment <= i) {
      i = comment - 1
      continue
    }
    return i
  }
  return -1
}

function lineCommentStart(source: string, i: number): number | null {
  const lineStart = source.lastIndexOf('\n', i) + 1
  let j = lineStart
  while (j < i) {
    const ch = source[j]
    if (ch === '/' && source[j + 1] === '/') return j
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      j++
      while (j < i && source[j] !== quote) {
        if (source[j] === '\\') j += 2
        else j++
      }
      j++
      continue
    }
    j++
  }
  return null
}

function parseStringArray(source: string, open: number, id: string): { close: number; elements: Quoted[] } {
  const elements: Quoted[] = []
  let i = open + 1
  // A leading, doubled, or elided comma is a hole. One trailing comma is fine.
  let commaPending = false
  while (i < source.length) {
    const ch = source[i]
    if (ch === undefined) break
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (ch === ',') {
      if (commaPending || elements.length === 0) throw uneditable(id)
      commaPending = true
      i++
      continue
    }
    if (ch === ']') return { close: i, elements }
    if (ch === "'" || ch === '"') {
      // `['a' 'b']` is not a list. One trailing comma leaves commaPending set.
      if (elements.length > 0 && !commaPending) throw uneditable(id)
      const quote = ch
      const start = i
      i++
      let value = ''
      let closed = false
      while (i < source.length) {
        const inner = source[i]
        if (inner === undefined || inner === '\n' || inner === '\r' || inner === '\\') {
          throw uneditable(id)
        }
        if (inner === quote) {
          i++
          closed = true
          break
        }
        value += inner
        i++
      }
      if (!closed) throw uneditable(id)
      elements.push({ value, quote, start, end: i })
      commaPending = false
      continue
    }
    throw uneditable(id)
  }
  throw uneditable(id)
}

function indentOfLine(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  let indent = ''
  for (let i = lineStart; i < index; i++) {
    const ch = source[i]
    if (ch !== ' ' && ch !== '\t') break
    indent += ch
  }
  return indent
}

function insertId(source: string, open: number, close: number, elements: Quoted[], id: string): string {
  const first = elements[0]
  const quote = first?.quote ?? "'"
  const quoted = `${quote}${id}${quote}`
  if (!first) {
    return source.slice(0, open) + `[${quoted}]` + source.slice(close + 1)
  }

  const inside = source.slice(open + 1, close)
  if (!inside.includes('\n')) {
    const body = inside.trimEnd()
    const spacer = body.endsWith(',') ? ' ' : ', '
    return source.slice(0, open + 1) + body + spacer + quoted + source.slice(close)
  }

  const last = elements[elements.length - 1]
  if (!last) throw uneditable(id)
  let cursor = last.end
  let hasComma = false
  while (cursor < close) {
    const ch = source[cursor]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      cursor++
      continue
    }
    hasComma = ch === ','
    break
  }

  let next = source
  let closeIdx = close
  if (!hasComma) {
    next = source.slice(0, last.end) + ',' + source.slice(last.end)
    closeIdx = close + 1
  }

  const indent = indentOfLine(next, last.start)
  const lineStart = next.lastIndexOf('\n', closeIdx - 1) + 1
  const beforeBracket = next.slice(lineStart, closeIdx)
  if (beforeBracket.trim() === '') {
    return next.slice(0, lineStart) + `${indent}${quoted}\n` + next.slice(lineStart)
  }
  // `]` shares this line. A newline before it drops the bracket to column 0.
  return next.slice(0, closeIdx) + `\n${indent}${quoted}` + next.slice(closeIdx)
}

export function insertEntrypoint(source: string, id: string): string {
  assertAgentId(id)
  const colons = findEntrypointColons(source, id)
  if (colons.length !== 1) throw uneditable(id)
  const colon = colons[0]
  if (colon === undefined) throw uneditable(id)

  let open = colon + 1
  while (open < source.length) {
    const ch = source[open]
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') break
    open++
  }
  if (source[open] !== '[') throw uneditable(id)

  const parsed = parseStringArray(source, open, id)
  // `const entrypoints: ['echo'] = ['echo']` is a typed binding. The colon
  // starts the type, so editing it would leave the runtime array unchanged.
  let after = parsed.close + 1
  while (after < source.length && isWs(source[after])) after++
  if (source[after] === '=') throw uneditable(id)
  if (parsed.elements.some((element) => element.value === id)) {
    throw new BreadError(
      `Agent "${id}" is already listed in entrypoints. Nothing was written.`,
      'SCAFFOLD_EXISTS',
      { id },
    )
  }
  return insertId(source, open, parsed.close, parsed.elements, id)
}
