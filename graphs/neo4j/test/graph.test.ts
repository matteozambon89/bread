import { describe, expect, test } from 'bun:test'
import { BreadError } from '@breadai/core'
import neo4j from 'neo4j-driver'
import { graph, type GraphDriverFactory } from '../src/index.js'

const LOOPBACK = 'bolt://127.0.0.1:7687'

function rejection(url: string): void {
  let calls = 0
  try {
    graph({ url }, () => {
      calls += 1
      throw new Error('factory')
    })
    throw new Error('expected GRAPH_URL_REJECTED')
  } catch (err) {
    if (err instanceof Error && err.message === 'expected GRAPH_URL_REJECTED') throw err
    expect(calls).toBe(0)
    expect(err).toBeInstanceOf(BreadError)
    const bread = err as BreadError
    expect(bread.code).toBe('GRAPH_URL_REJECTED')
    expect(bread.message).toBe('Graph URL is not allowed.')
    expect(bread.context).toBeUndefined()
    expect(bread.cause).toBeUndefined()
    expect(bread.message).not.toContain('secret')
    expect(bread.message).not.toContain('password')
  }
}

interface Probe {
  mode: string
  read: number
  write: number
  closed: number
  timeout: number | undefined
}

function recordsOf(rows: Record<string, unknown>[]) {
  return rows.map((fields) => ({
    keys: Object.keys(fields),
    get(key: string) {
      return fields[key]
    },
  }))
}

function connected(opts?: {
  rows?: Record<string, unknown>[]
  hang?: boolean
  explode?: unknown
}): {
  factory: GraphDriverFactory
  probes: Probe[]
  opened: { count: number }
  driverClosed: { count: number }
  seen: { url?: string; auth?: unknown; config?: { fetchSize: number; maxTransactionRetryTime: number } }
  seenParams: { statement?: string; params?: Record<string, unknown> }
} {
  const probes: Probe[] = []
  const opened = { count: 0 }
  const driverClosed = { count: 0 }
  const seen: { url?: string; auth?: unknown; config?: { fetchSize: number; maxTransactionRetryTime: number } } = {}
  const seenParams: { statement?: string; params?: Record<string, unknown> } = {}
  const factory: GraphDriverFactory = (url, auth, config) => {
    opened.count += 1
    seen.url = url
    seen.auth = auth
    seen.config = config
    return {
      session(sessionConfig) {
        const probe: Probe = { mode: sessionConfig.defaultAccessMode, read: 0, write: 0, closed: 0, timeout: undefined }
        probes.push(probe)
        const tx = {
          run(statement: string, params: Record<string, unknown>) {
            seenParams.statement = statement
            seenParams.params = params
            if (opts?.explode) throw opts.explode
            return recordsOf(opts?.rows ?? [])
          },
        }
        return {
          executeRead(work: (inner: typeof tx) => Promise<unknown>, config?: { timeout?: number }) {
            probe.read += 1
            probe.timeout = config?.timeout
            if (opts?.hang) return new Promise(() => {})
            return work(tx)
          },
          executeWrite(work: (inner: typeof tx) => Promise<unknown>, config?: { timeout?: number }) {
            probe.write += 1
            probe.timeout = config?.timeout
            if (opts?.hang) return new Promise(() => {})
            return work(tx)
          },
          async close() {
            probe.closed += 1
          },
        }
      },
      async close() {
        driverClosed.count += 1
      },
    }
  }
  return { factory, probes, opened, driverClosed, seen, seenParams }
}

describe('graph url', () => {
  test('userinfo, query, hash, and unparseable urls are rejected before the driver exists', () => {
    for (const url of [
      'bolt://user:secret@127.0.0.1:7687',
      'bolt://user@127.0.0.1:7687',
      'bolt://user:secret@db.example.com:7687',
      'bolt://127.0.0.1:7687?password=secret',
      'bolt://127.0.0.1:7687#secret',
      'not a url user:secret',
    ]) {
      rejection(url)
    }
  })

  test('remote cleartext is rejected and encrypted schemes are accepted', async () => {
    rejection('bolt://db.example.com:7687')
    rejection('neo4j://db.example.com')
    rejection('bolt://127.0.0.2:7687')
    for (const url of [
      'bolt+s://db.example.com:7687',
      'neo4j+s://db.example.com',
      'bolt+ssc://db.example.com:7687',
      'neo4j+ssc://db.example.com',
      LOOPBACK,
      'neo4j://localhost:7687',
      'bolt://[::1]:7687',
    ]) {
      const { factory, seen } = connected()
      const handle = graph({ url }, factory)
      await handle.run('RETURN 1', {}, 'read')
      expect(seen.url).toBe(new URL(url).href)
      await handle.close()
    }
  })

  test('a later write to options.url cannot replace the checked url', async () => {
    const options: { url: string; auth?: { username: string; password: string } } = { url: LOOPBACK }
    const { factory, seen } = connected()
    const handle = graph(options, factory)
    options.url = 'bolt://user:secret@db.example.com:7687'
    await handle.run('RETURN 1', {}, 'read')
    expect(seen.url).toBe(LOOPBACK)
    expect(JSON.stringify(handle)).not.toContain('secret')
  })

  test('auth stays inside the driver token and off the returned object', async () => {
    const { factory, seen, opened } = connected()
    const handle = graph(
      { url: LOOPBACK, auth: { username: 'neo4j', password: 'test-password' } },
      factory,
    )
    expect(Object.keys(handle).sort()).toEqual(['close', 'run'])
    expect(JSON.stringify(handle)).not.toContain('test-password')
    await handle.run('RETURN 1', {}, 'read')
    expect(seen.url).toBe(LOOPBACK)
    expect(seen.auth).toEqual(neo4j.auth.basic('neo4j', 'test-password'))
    expect(String(seen.url)).not.toContain('test-password')
    await handle.close()
    expect(opened.count).toBe(1)
  })
})

describe('graph run', () => {
  test('one session per run, closed when the work throws', async () => {
    const { factory, probes } = connected({ explode: new Error('connection refused bolt://secret') })
    const handle = graph({ url: LOOPBACK }, factory)
    await expect(handle.run('MATCH (n) RETURN n', { name: 'prep' }, 'read')).rejects.toMatchObject({
      message: 'Graph query failed.',
      code: 'GRAPH_QUERY_FAILED',
    })
    expect(probes).toHaveLength(1)
    expect(probes[0]?.closed).toBe(1)

    const second = connected({ explode: new Error('again') })
    const other = graph({ url: LOOPBACK }, second.factory)
    await expect(other.run('MATCH (n) RETURN n', {}, 'write')).rejects.toBeInstanceOf(BreadError)
    expect(second.probes).toHaveLength(1)
    expect(second.probes[0]?.closed).toBe(1)
  })

  test('read and write use the matching transaction and access mode', async () => {
    const read = connected({ rows: [{ name: 'prep' }] })
    const reader = graph({ url: LOOPBACK, limits: { timeoutMs: 25 } }, read.factory)
    const readResult = await reader.run('MATCH (n) RETURN n.name AS name', {}, 'read')
    expect(readResult).toEqual({ rows: [{ name: 'prep' }], truncated: false })
    expect(read.probes[0]?.read).toBe(1)
    expect(read.probes[0]?.write).toBe(0)
    expect(read.probes[0]?.mode).toBe(neo4j.session.READ)
    expect(read.probes[0]?.timeout).toBe(25)
    expect(read.seen.config).toEqual({ fetchSize: 100, maxTransactionRetryTime: 25 })

    const write = connected({ rows: [{ station: 'prep' }] })
    const writer = graph({ url: LOOPBACK }, write.factory)
    await writer.run('CREATE (n) RETURN n', {}, 'write')
    expect(write.probes[0]?.write).toBe(1)
    expect(write.probes[0]?.read).toBe(0)
    expect(write.probes[0]?.mode).toBe(neo4j.session.WRITE)
  })

  test('row and byte caps set truncated without keeping the dropped row', async () => {
    const rows = connected({
      rows: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    })
    const capped = graph({ url: LOOPBACK, limits: { rows: 2 } }, rows.factory)
    await expect(capped.run('MATCH (n) RETURN n.name AS name', {}, 'read')).resolves.toEqual({
      rows: [{ name: 'a' }, { name: 'b' }],
      truncated: true,
    })

    const wide = connected({
      rows: [{ name: 'ok' }, { name: 'x'.repeat(400) }],
    })
    const bytes = graph({ url: LOOPBACK, limits: { bytes: 40 } }, wide.factory)
    const partial = await bytes.run('MATCH (n) RETURN n.name AS name', {}, 'read')
    expect(partial.truncated).toBe(true)
    expect(partial.rows).toEqual([{ name: 'ok' }])

    const huge = connected({ rows: [{ name: 'y'.repeat(400) }] })
    const first = graph({ url: LOOPBACK, limits: { bytes: 40 } }, huge.factory)
    await expect(first.run('MATCH (n) RETURN n.name AS name', {}, 'read')).resolves.toEqual({
      rows: [],
      truncated: true,
    })
  })

  test('timeout and an aborted signal fail and still close the session', async () => {
    const slow = connected({ hang: true })
    const handle = graph({ url: LOOPBACK, limits: { timeoutMs: 30 } }, slow.factory)
    await expect(handle.run('MATCH (n) RETURN n', {}, 'read')).rejects.toMatchObject({
      message: 'Graph query failed.',
      code: 'GRAPH_QUERY_FAILED',
    })
    expect(slow.probes[0]?.closed).toBe(1)
    const err = await handle.run('MATCH (n) RETURN n', {}, 'read').catch((caught: unknown) => caught)
    expect(err).toBeInstanceOf(BreadError)
    expect((err as BreadError).context).toBeUndefined()
    expect((err as BreadError).cause).toBeUndefined()

    const aborted = connected({ hang: true })
    const live = graph({ url: LOOPBACK, limits: { timeoutMs: 30_000 } }, aborted.factory)
    const controller = new AbortController()
    const pending = live.run('MATCH (n) RETURN n', {}, 'read', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'GRAPH_QUERY_FAILED', message: 'Graph query failed.' })
    expect(aborted.probes).toHaveLength(1)
    expect(aborted.probes[0]?.closed).toBe(1)

    const early = connected()
    const already = new AbortController()
    already.abort()
    const closed = graph({ url: LOOPBACK }, early.factory)
    await expect(closed.run('MATCH (n) RETURN n', {}, 'read', already.signal)).rejects.toMatchObject({
      code: 'GRAPH_QUERY_FAILED',
    })
    expect(early.opened.count).toBe(0)
    expect(early.probes).toHaveLength(0)
  })

  test('driver values become plain json and driver errors stay fixed', async () => {
    const big = neo4j.int('9223372036854775807')
    const { factory } = connected({
      rows: [
        {
          n: neo4j.int(7),
          nested: { n: neo4j.int(4) },
          big,
        },
      ],
    })
    const handle = graph({ url: LOOPBACK }, factory)
    const result = await handle.run('MATCH (n) RETURN n', {}, 'read')
    expect(result.rows).toEqual([{ n: 7, nested: { n: 4 }, big: '9223372036854775807' }])
    expect(JSON.parse(JSON.stringify(result.rows[0]))).toEqual(result.rows[0])
    expect(JSON.stringify(result.rows[0])).not.toContain('"low"')

    const broken = connected({ explode: new Error('connection refused bolt://secret') })
    const failing = graph({ url: LOOPBACK }, broken.factory)
    const err = await failing.run('MATCH (n) RETURN n', {}, 'read').catch((caught: unknown) => caught)
    expect(err).toBeInstanceOf(BreadError)
    const bread = err as BreadError
    expect(bread.message).toBe('Graph query failed.')
    expect(bread.code).toBe('GRAPH_QUERY_FAILED')
    expect(bread.context).toBeUndefined()
    expect(bread.cause).toBeUndefined()
    expect(bread.message).not.toContain('connection refused')
    expect(broken.probes[0]?.closed).toBe(1)
  })

  test('safe integers are packed as neo4j ints and other numbers stay floats', async () => {
    const { factory, seenParams } = connected()
    const handle = graph({ url: LOOPBACK }, factory)
    const already = neo4j.int(9)
    const nested = { count: 2, ratio: 1.25, flags: [1, 0, 2.5] }
    const items = [3, 4.25, { skip: 0 }]
    const params = {
      limit: 10,
      skip: 0,
      score: 0.5,
      missing: Number.NaN,
      wide: Number.POSITIVE_INFINITY,
      huge: Number.MAX_SAFE_INTEGER,
      low: Number.MIN_SAFE_INTEGER,
      unsafe: Number.MAX_SAFE_INTEGER + 1,
      nested,
      items,
      already,
      text: 'prep',
      flag: true,
      empty: null,
    }
    await handle.run('MATCH (n) RETURN n LIMIT $limit', params, 'read')
    const packed = seenParams.params!
    const asInt = (value: unknown): number => {
      expect(neo4j.isInt(value)).toBe(true)
      return (value as { toNumber(): number }).toNumber()
    }
    expect(asInt(packed.limit)).toBe(10)
    expect(asInt(packed.skip)).toBe(0)
    expect(packed.score).toBe(0.5)
    expect(neo4j.isInt(packed.score)).toBe(false)
    expect(Number.isNaN(packed.missing)).toBe(true)
    expect(packed.wide).toBe(Number.POSITIVE_INFINITY)
    expect(asInt(packed.huge)).toBe(Number.MAX_SAFE_INTEGER)
    expect(asInt(packed.low)).toBe(Number.MIN_SAFE_INTEGER)
    expect(packed.unsafe).toBe(Number.MAX_SAFE_INTEGER + 1)
    expect(neo4j.isInt(packed.unsafe)).toBe(false)
    const packedNested = packed.nested as { count: unknown; ratio: unknown; flags: unknown[] }
    expect(packedNested).not.toBe(nested)
    expect(asInt(packedNested.count)).toBe(2)
    expect(packedNested.ratio).toBe(1.25)
    expect(asInt(packedNested.flags[0])).toBe(1)
    expect(asInt(packedNested.flags[1])).toBe(0)
    expect(packedNested.flags[2]).toBe(2.5)
    const packedItems = packed.items as [unknown, unknown, { skip: unknown }]
    expect(packedItems).not.toBe(items)
    expect(asInt(packedItems[0])).toBe(3)
    expect(packedItems[1]).toBe(4.25)
    expect(asInt(packedItems[2].skip)).toBe(0)
    expect(packed.already).toBe(already)
    expect(packed.text).toBe('prep')
    expect(packed.flag).toBe(true)
    expect(packed.empty).toBeNull()
    expect(params.limit).toBe(10)
    expect(nested.count).toBe(2)
    expect(items[0]).toBe(3)
  })

  test('close before the first run does not construct the driver', async () => {
    const idle = connected()
    const handle = graph({ url: LOOPBACK }, idle.factory)
    await handle.close()
    expect(idle.opened.count).toBe(0)
    expect(idle.driverClosed.count).toBe(0)

    await handle.run('RETURN 1', {}, 'read')
    expect(idle.opened.count).toBe(1)
    await handle.close()
    expect(idle.driverClosed.count).toBe(1)
  })
})
