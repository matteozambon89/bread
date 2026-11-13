import { Buffer } from 'node:buffer'
import { BreadError, isLoopbackHostname, type Graph, type GraphResult } from '@breadai/core'
import neo4j from 'neo4j-driver'

const DEFAULT_ROWS = 100
const DEFAULT_BYTES = 1_048_576
const DEFAULT_TIMEOUT_MS = 10_000

const SECURE_SCHEMES = new Set(['bolt+s', 'neo4j+s', 'bolt+ssc', 'neo4j+ssc'])
const CLEAR_SCHEMES = new Set(['bolt', 'neo4j'])

const OVER = Symbol('over')

export interface GraphOptions {
  url: string
  auth?: { username: string; password: string }
  limits?: { rows?: number; bytes?: number; timeoutMs?: number }
}

interface DriverConfig {
  fetchSize: number
  maxTransactionRetryTime: number
}

interface QueryRecord {
  keys: string[]
  get(key: string): unknown
}

interface QueryTx {
  run(statement: string, params: Record<string, unknown>): AsyncIterable<QueryRecord>
}

interface QuerySession {
  executeRead<T>(work: (tx: QueryTx) => Promise<T>, config?: { timeout?: number }): Promise<T>
  executeWrite<T>(work: (tx: QueryTx) => Promise<T>, config?: { timeout?: number }): Promise<T>
  close(): Promise<void>
}

interface QueryDriver {
  session(config: { defaultAccessMode: string }): QuerySession
  close(): Promise<void>
}

export type GraphDriverFactory = (url: string, auth: unknown, config: DriverConfig) => QueryDriver

function rejected(): never {
  throw new BreadError('Graph URL is not allowed.', 'GRAPH_URL_REJECTED')
}

function failed(): never {
  throw new BreadError('Graph query failed.', 'GRAPH_QUERY_FAILED')
}

// Driver 6 sends every JS number as a float. Neo4j rejects a float LIMIT or SKIP.
function packValue(value: unknown): unknown {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? neo4j.int(value) : value
  if (Array.isArray(value)) return value.map((entry) => packValue(entry))
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const packed: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      packed[key] = packValue((value as Record<string, unknown>)[key])
    }
    return packed
  }
  return value
}

function packParams(params: Record<string, unknown>): Record<string, unknown> {
  return packValue(params) as Record<string, unknown>
}

// Checked once, before the driver exists. Later mutation of options.url cannot widen it.
function acceptedUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    rejected()
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') rejected()
  const scheme = url.protocol.endsWith(':') ? url.protocol.slice(0, -1) : url.protocol
  const loopback = isLoopbackHostname(url.hostname)
  const secure = SECURE_SCHEMES.has(scheme)
  if (loopback) {
    if (!secure && !CLEAR_SCHEMES.has(scheme)) rejected()
  } else if (!secure) {
    rejected()
  }
  return url.href
}

function defaultFactory(url: string, auth: unknown, config: DriverConfig): QueryDriver {
  return neo4j.driver(url, auth as Parameters<typeof neo4j.driver>[1], config) as unknown as QueryDriver
}

type Budget = { left: number }

function take(budget: Budget, bytes: number): boolean {
  if (bytes > budget.left) return false
  budget.left -= bytes
  return true
}

function stringJsonBytes(value: string): number | null {
  // A string of quotes expands. Refuse the obvious overflow before allocating the JSON form.
  if (value.length > 0 && Buffer.byteLength(value) + 2 > Number.MAX_SAFE_INTEGER) return null
  return Buffer.byteLength(JSON.stringify(value))
}

function putString(value: string, budget: Budget): string | typeof OVER {
  const lower = Buffer.byteLength(value) + 2
  if (lower > budget.left) return OVER
  const bytes = stringJsonBytes(value)
  if (bytes === null || !take(budget, bytes)) return OVER
  return value
}

function convertValue(value: unknown, budget: Budget): unknown {
  if (value === null || value === undefined) {
    if (!take(budget, 4)) return OVER
    return null
  }
  if (typeof value === 'string') return putString(value, budget)
  if (typeof value === 'boolean') {
    if (!take(budget, value ? 4 : 5)) return OVER
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      if (!take(budget, 4)) return OVER
      return null
    }
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (!take(budget, bytes)) return OVER
    return value
  }
  if (typeof value === 'bigint') return putString(value.toString(), budget)
  if (neo4j.isInt(value)) {
    const plain = value.inSafeRange() ? value.toNumber() : value.toString()
    return convertValue(plain, budget)
  }
  if (value instanceof Uint8Array) {
    const encodedLength = Math.ceil(value.byteLength / 3) * 4
    if (encodedLength + 2 > budget.left) return OVER
    return putString(Buffer.from(value).toString('base64'), budget)
  }
  if (neo4j.isNode(value)) {
    return convertValue({ labels: value.labels, properties: value.properties }, budget)
  }
  if (neo4j.isRelationship(value) || neo4j.isUnboundRelationship(value)) {
    const rel = value as { type: string; start?: unknown; end?: unknown; properties: Record<string, unknown> }
    const plain: Record<string, unknown> = { type: rel.type, properties: rel.properties }
    if (neo4j.isRelationship(value)) {
      plain.start = rel.start
      plain.end = rel.end
    }
    return convertValue(plain, budget)
  }
  if (neo4j.isPath(value)) {
    return convertValue(
      {
        segments: value.segments.map((segment) => ({
          start: segment.start,
          relationship: segment.relationship,
          end: segment.end,
        })),
      },
      budget,
    )
  }
  if (
    neo4j.isDate(value) ||
    neo4j.isDateTime(value) ||
    neo4j.isLocalDateTime(value) ||
    neo4j.isTime(value) ||
    neo4j.isLocalTime(value) ||
    neo4j.isDuration(value) ||
    neo4j.isPoint(value)
  ) {
    return putString(value.toString(), budget)
  }
  if (Array.isArray(value)) {
    if (!take(budget, 1)) return OVER
    const out: unknown[] = []
    for (const entry of value) {
      if (out.length > 0 && !take(budget, 1)) return OVER
      const child = convertValue(entry, budget)
      if (child === OVER) return OVER
      out.push(child)
    }
    if (!take(budget, 1)) return OVER
    return out
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return putString(String(value), budget)
    if (!take(budget, 1)) return OVER
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const childRaw = (value as Record<string, unknown>)[key]
      if (childRaw === undefined) continue
      const comma = Object.keys(out).length > 0 ? 1 : 0
      const keyBytes = Buffer.byteLength(JSON.stringify(key))
      if (!take(budget, comma + keyBytes + 1)) return OVER
      const child = convertValue(childRaw, budget)
      if (child === OVER) return OVER
      out[key] = child
    }
    if (!take(budget, 1)) return OVER
    return out
  }
  return putString(String(value), budget)
}

function convertRecord(record: QueryRecord, byteCap: number): { row: Record<string, unknown>; bytes: number } | null {
  const budget: Budget = { left: byteCap }
  if (!take(budget, 1)) return null
  const row: Record<string, unknown> = {}
  for (const key of record.keys) {
    const comma = Object.keys(row).length > 0 ? 1 : 0
    const keyBytes = Buffer.byteLength(JSON.stringify(String(key)))
    if (!take(budget, comma + keyBytes + 1)) return null
    const child = convertValue(record.get(key), budget)
    if (child === OVER) return null
    row[key] = child
  }
  if (!take(budget, 1)) return null
  return { row, bytes: byteCap - budget.left }
}

async function collect(result: AsyncIterable<QueryRecord>, rowCap: number, byteCap: number): Promise<GraphResult> {
  const rows: Record<string, unknown>[] = []
  let used = 0
  let truncated = false
  for await (const record of result) {
    if (rows.length >= rowCap) {
      truncated = true
      break
    }
    const converted = convertRecord(record, byteCap - used)
    if (!converted) {
      truncated = true
      break
    }
    rows.push(converted.row)
    used += converted.bytes
  }
  return { rows, truncated }
}

export function graph(options: GraphOptions, factory?: GraphDriverFactory): Graph {
  const url = acceptedUrl(options.url)
  const rowCap = options.limits?.rows ?? DEFAULT_ROWS
  const byteCap = options.limits?.bytes ?? DEFAULT_BYTES
  const timeoutMs = options.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let username: string | undefined = options.auth?.username
  let password: string | undefined = options.auth?.password
  let authToken: unknown
  let driver: QueryDriver | undefined
  const create = factory ?? defaultFactory

  function ensureDriver(): QueryDriver {
    if (driver) return driver
    if (authToken === undefined) {
      // Driver 6 ships auth.none at runtime. The published types omit it.
      const none = (neo4j.auth as { none?: () => unknown }).none
      authToken = username === undefined ? (none ? none() : { scheme: 'none' }) : neo4j.auth.basic(username, password ?? '')
      username = undefined
      password = undefined
    }
    try {
      driver = create(url, authToken, { fetchSize: rowCap, maxTransactionRetryTime: timeoutMs })
    } catch {
      failed()
    }
    return driver
  }

  return {
    async run(statement, params, mode, signal) {
      if (signal?.aborted) failed()
      let session: QuerySession | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      let closing: Promise<void> | undefined
      const closeSession = (): Promise<void> => {
        if (!session) return Promise.resolve()
        if (!closing) {
          const current = session
          // One close, shared by the abort/timeout path and finally.
          closing = current.close().then(
            () => undefined,
            () => undefined,
          )
        }
        return closing
      }
      try {
        session = ensureDriver().session({
          defaultAccessMode: mode === 'read' ? neo4j.session.READ : neo4j.session.WRITE,
        })
        const execute = mode === 'read' ? session.executeRead.bind(session) : session.executeWrite.bind(session)
        const work = execute(
          (tx) => collect(tx.run(statement, packParams(params)), rowCap, byteCap),
          { timeout: timeoutMs },
        )
        return await new Promise<GraphResult>((resolve, reject) => {
          let settled = false
          const finish = (settle: () => void) => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            if (onAbort && signal) signal.removeEventListener('abort', onAbort)
            settle()
          }
          timer = setTimeout(() => {
            void closeSession()
            finish(() => reject(new Error('timeout')))
          }, timeoutMs)
          if (signal) {
            onAbort = () => {
              void closeSession()
              finish(() => reject(new Error('aborted')))
            }
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) onAbort()
          }
          work.then(
            (value) => finish(() => resolve(value)),
            () => finish(() => reject(new Error('failed'))),
          )
        })
      } catch {
        failed()
      } finally {
        if (timer) clearTimeout(timer)
        if (onAbort && signal) signal.removeEventListener('abort', onAbort)
        await closeSession()
      }
    },

    async close() {
      const current = driver
      driver = undefined
      if (!current) return
      try {
        await current.close()
      } catch {
        failed()
      }
    },
  }
}
