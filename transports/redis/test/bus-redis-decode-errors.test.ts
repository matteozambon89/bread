import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { BreadCrumb } from '@bread/core'
import { transport } from '@bread/transport-redis'
import { Redis } from 'ioredis'
import { v7 as uuidv7 } from 'uuid'
import { spawnRedisForTest } from './redis-server'

// Bespoke coverage for @bread/transport-redis's own decode-failure surfacing
// (version tag + shape validation on the `frame` field it writes/reads) —
// the shared runTransportContract suite in bus-redis.test.ts only covers
// well-formed frames. No mocks: malformed entries are injected via a raw
// ioredis client's own XADD, bypassing this package's publish().

const envUrl = process.env.REDIS_URL
const binary = envUrl ? null : Bun.which('redis-server')
const available = Boolean(envUrl || binary)

let url = envUrl ?? ''
let stopServer = () => {}

if (available) {
  beforeAll(async () => {
    if (envUrl) return
    const server = await spawnRedisForTest(binary!)
    url = server.url
    stopServer = server.stop
  })

  afterAll(() => {
    stopServer()
  })
}

const maybeTest = available ? test : test.skip

function crumb(runId: string, seq: number): BreadCrumb {
  return {
    type: 'text:delta',
    agentId: 'a',
    runId,
    sessionId: 's',
    timestamp: 1,
    seq,
    delta: `d${seq}`,
  }
}

function validFrameField(runId: string, seq: number): string {
  return JSON.stringify({ v: 1, runId, seq, crumb: crumb(runId, seq) })
}

async function waitForLength(arr: unknown[], n: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (arr.length < n) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} frames, got ${arr.length}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('@bread/transport-redis decode-error surfacing', () => {
  maybeTest('replay: skips malformed entries, delivers surrounding valid frames, logs context', async () => {
    const runId = `r-${uuidv7()}`
    const keyPrefix = `bread:decode-test:${uuidv7()}:`
    const streamKey = `${keyPrefix}{${runId}}`
    const raw = new Redis(url)
    const t = transport({ url, keyPrefix, blockMs: 50 })
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    try {
      await raw.xadd(streamKey, '*', 'frame', validFrameField(runId, 1))
      await raw.xadd(streamKey, '*', 'frame', 'not-json{')
      await raw.xadd(streamKey, '*', 'frame', JSON.stringify({ v: 1, seq: 2 }))
      await raw.xadd(streamKey, '*', 'frame', validFrameField(runId, 3))

      console.warn = (...args: unknown[]) => warnings.push(args)
      await t.init?.()
      const got: number[] = []
      t.subscribe?.(runId, 0, (f) => got.push(f.seq))
      await waitForLength(got, 2)

      expect(got).toEqual([1, 3])
      expect(warnings.length).toBe(2)
      expect(String(warnings[0]?.[0])).toContain(streamKey)
      expect(String(warnings[0]?.[1])).toContain('invalid JSON')
      expect(String(warnings[1]?.[1])).toContain('runId')
    } finally {
      console.warn = originalWarn
      await t.close?.()
      raw.disconnect()
    }
  })

  maybeTest('live tail: skips malformed entries injected mid-stream, other frames still arrive in order', async () => {
    const runId = `r-${uuidv7()}`
    const keyPrefix = `bread:decode-test:${uuidv7()}:`
    const streamKey = `${keyPrefix}{${runId}}`
    const raw = new Redis(url)
    const t = transport({ url, keyPrefix, blockMs: 50 })
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    try {
      await t.init?.()
      const got: number[] = []
      t.subscribe?.(runId, 0, (f) => got.push(f.seq))
      // Let subscribe's anchor (XREVRANGE) resolve and the live read loop
      // reach its first blocking iteration before publishing, so frames
      // below are picked up by live tail, not raced against subscribe setup.
      await new Promise((r) => setTimeout(r, 150))

      console.warn = (...args: unknown[]) => warnings.push(args)
      await t.publish({ runId, seq: 1, crumb: crumb(runId, 1) })
      await raw.xadd(streamKey, '*', 'frame', JSON.stringify({ v: 99, runId, seq: 2, crumb: crumb(runId, 2) }))
      await raw.xadd(streamKey, '*', 'frame', 'still not json')
      await t.publish({ runId, seq: 3, crumb: crumb(runId, 3) })

      await waitForLength(got, 2)
      expect(got).toEqual([1, 3])
      expect(warnings.length).toBe(2)
      expect(String(warnings[0]?.[1])).toContain('unsupported version')
    } finally {
      console.warn = originalWarn
      await t.close?.()
      raw.disconnect()
    }
  })
})
