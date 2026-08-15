import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { runTransportContract } from '@bread/test-utils'
import { transport } from '@bread/transport-redis'
import { v7 as uuidv7 } from 'uuid'
import { spawnRedisForTest } from './redis-server'

// Doesn't need a live Redis at all — requireStarted() throws synchronously
// before any connection is touched, for both publish() and subscribe().
describe('@bread/transport-redis — requireStarted()', () => {
  test('publish() before init() throws "not started"', async () => {
    const t = transport({ url: 'redis://127.0.0.1:1' })
    expect(t.publish({ runId: 'r1', seq: 1, crumb: { type: 'agent:run:start' } as never })).rejects.toThrow(
      /not started — call init\(\) first/,
    )
  })

  test('subscribe() before init() throws "not started"', () => {
    const t = transport({ url: 'redis://127.0.0.1:1' })
    expect(() => t.subscribe?.('r1', 0, () => {})).toThrow(/not started — call init\(\) first/)
  })
})

// Redis test strategy (user decision): use REDIS_URL when set; otherwise
// spawn a local `redis-server` binary on an ephemeral port; otherwise register
// every contract case as visibly skipped. No mocks — the contract must run
// against real Redis Streams semantics or not at all.

const envUrl = process.env.REDIS_URL
const binary = envUrl ? null : Bun.which('redis-server')

let url = envUrl ?? ''
let stopServer = () => {}

if (envUrl || binary) {
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

runTransportContract(
  '@bread/transport-redis (Redis Streams)',
  // Short block timeout so subscription pickup doesn't dominate test time. A
  // fresh keyPrefix per case isolates it in Redis's own persisted keyspace —
  // unlike streamTransport()'s in-memory Map, real Redis data outlives one
  // transport instance, and every contract case reuses the same runIds
  // ('r1'/'r2'); without this, a later case's replay would see an earlier
  // case's leftover frames on the same key.
  () => transport({ url, blockMs: 50, keyPrefix: `bread:contract-test:${uuidv7()}:` }),
  envUrl || binary ? {} : { skipReason: 'no REDIS_URL and no redis-server on PATH' },
)
