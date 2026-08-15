import { Redis } from 'ioredis'
import type { BreadTransport, BusFrame, Unsubscribe } from '@breadai/core'

// Redis Streams transport — the crumb fabric between replicas of one bread
// app. One stream per run (`bread:run:{<runId>}`; braces = cluster hash tag),
// so per-run ordering falls out of per-key ordering and trimming is natural.
//
// Publish: XADD with approximate MAXLEN + a key TTL — trimming is safe since
// the store remains the durable source of truth.
// Subscribe: one dedicated blocking connection multiplexes a single
// `XREAD BLOCK` over every subscribed run (broadcast — every replica sees
// every frame; consumer groups would make replicas COMPETE instead). The
// block timeout doubles as the pickup point for added/removed subscriptions,
// so a new subscription goes live within ~`blockMs`. Per-key last-delivered
// ids survive ioredis auto-reconnects → at-least-once delivery, duplicates
// possible around a reconnect (the BreadTransport contract).
//
// `capability: 'duplex'` — full seq-based `subscribe(runId, afterSeq)` replay:
// every subscribe() call independently XRANGEs the run's whole retained
// history (bounded by maxLen/ttl, same as the store-is-truth division of
// labour) and replays entries with `frame.seq > afterSeq` to that handler,
// in order, before live frames start arriving. The handler is registered for
// live delivery *before* that XRANGE is issued, so a frame published mid-
// replay is never lost — at worst it is delivered twice (replay + live),
// which the BreadTransport contract already allows.

export interface RedisTransportOptions {
  /** Connection string. Defaults to REDIS_URL, then redis://localhost:6379. */
  url?: string
  /** Stream key prefix. Default `bread:run:`. */
  keyPrefix?: string
  /** Approximate per-stream cap (XADD MAXLEN ~). Default 10_000. */
  maxLen?: number
  /** Per-stream TTL, refreshed on every publish. Default 86_400 (one day). */
  ttlSeconds?: number
  /** XREAD block timeout — the subscription-set refresh cadence. Default 1000. */
  blockMs?: number
}

interface Subscription {
  handlers: Set<(frame: BusFrame) => void>
  // Last delivered stream id for live tailing; null until `anchor` resolves
  // the stream's tail-at-subscribe-time (the boundary past which the live
  // XREAD loop takes over — see `replayTo` for the pre-live catch-up).
  lastId: string | null
  anchor: Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Wire-format version for this package's own Redis Stream `frame` field
// encoding — independent of BREAD_PROTOCOL_VERSION (packages/core/src/protocol.ts),
// which versions a different wire envelope (HTTP chunked/SSE).
const FRAME_VERSION = 1

export function transport(opts: RedisTransportOptions = {}): BreadTransport {
  const url = opts.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379'
  const keyPrefix = opts.keyPrefix ?? 'bread:run:'
  const maxLen = opts.maxLen ?? 10_000
  const ttlSeconds = opts.ttlSeconds ?? 86_400
  const blockMs = opts.blockMs ?? 1000

  const key = (runId: string) => `${keyPrefix}{${runId}}`
  const runIdOf = (streamKey: string) => streamKey.slice(keyPrefix.length + 1, -1)

  // Two connections: `pub` serves XADD + anchor lookups; `sub` is dedicated to
  // the blocking XREAD loop (a blocked connection can run nothing else).
  let pub: Redis | null = null
  let sub: Redis | null = null
  let running = false
  let loop: Promise<void> | null = null

  const subs = new Map<string, Subscription>()

  function requireStarted(): { pub: Redis; sub: Redis } {
    if (!pub || !sub) {
      throw new Error('@breadai/transport-redis: not started — call init() first (bread.start does)')
    }
    return { pub, sub }
  }

  // Parses one XRANGE/XREAD entry's `frame` field back into a BusFrame.
  // Validates shape/version; on any failure logs why (stream, entry id,
  // reason) and returns null so the caller skips this one entry and keeps
  // going — never throws (readLoop/replayTo must not stop for one bad entry).
  function parseFrame(streamKey: string, id: string, fields: string[]): BusFrame | null {
    const fail = (reason: string): null => {
      console.warn(
        `[bread] @breadai/transport-redis: dropping malformed frame (stream=${streamKey} id=${id}):`,
        reason,
      )
      return null
    }

    const json = fields[fields.indexOf('frame') + 1]
    if (json === undefined) return fail('entry has no "frame" field')

    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (err) {
      return fail(`invalid JSON (${(err as Error).message})`)
    }

    if (typeof parsed !== 'object' || parsed === null) return fail('decoded value is not an object')
    const obj = parsed as Record<string, unknown>

    if (obj.v !== FRAME_VERSION) return fail(`unsupported version "${String(obj.v)}" (expected ${FRAME_VERSION})`)
    if (typeof obj.runId !== 'string') return fail('missing or non-string "runId"')
    if (typeof obj.seq !== 'number') return fail('missing or non-number "seq"')
    if (typeof obj.crumb !== 'object' || obj.crumb === null) return fail('missing or non-object "crumb"')

    return { runId: obj.runId, seq: obj.seq, crumb: obj.crumb as BusFrame['crumb'] }
  }

  // Independent, per-handler catch-up: XRANGE's the run's whole retained
  // history and replays entries with `seq > afterSeq`, in order, to this one
  // handler. Called after the handler is already registered for live
  // delivery, so nothing published mid-replay is lost (worst case: a
  // duplicate, which the BreadTransport contract allows).
  async function replayTo(
    runId: string,
    afterSeq: number,
    handler: (frame: BusFrame) => void,
  ): Promise<void> {
    const { pub: p } = requireStarted()
    const streamKey = key(runId)
    const entries = (await p.xrange(streamKey, '-', '+')) as Array<[string, string[]]>
    for (const [id, fields] of entries) {
      const frame = parseFrame(streamKey, id, fields)
      if (frame && frame.seq > afterSeq) {
        try {
          handler(frame)
        } catch {
          // handler errors must not stop delivery (BreadTransport contract)
        }
      }
    }
  }

  async function readLoop(subConn: Redis): Promise<void> {
    while (running) {
      try {
        // Wait for in-flight anchors so a just-added subscription joins this
        // iteration instead of silently skipping a block cycle.
        await Promise.all([...subs.values()].map((s) => s.anchor))
        const anchored = [...subs.entries()].filter(([, s]) => s.lastId !== null)
        if (anchored.length === 0) {
          await sleep(blockMs)
          continue
        }

        const streams = anchored.map(([runId]) => key(runId))
        const ids = anchored.map(([, s]) => s.lastId!)
        const reply = (await subConn.xread('BLOCK', blockMs, 'STREAMS', ...streams, ...ids)) as
          | Array<[string, Array<[string, string[]]>]>
          | null
        if (!reply) continue

        for (const [streamKey, entries] of reply) {
          const state = subs.get(runIdOf(streamKey))
          for (const [id, fields] of entries) {
            if (state) state.lastId = id
            if (!state || state.handlers.size === 0) continue
            const frame = parseFrame(streamKey, id, fields)
            if (!frame) continue
            for (const handler of state.handlers) {
              try {
                handler(frame)
              } catch {
                // handler errors must not stop delivery (BreadTransport contract)
              }
            }
          }
        }
      } catch (err) {
        if (!running) return
        console.warn('[bread] @breadai/transport-redis: read failed (retrying):', err)
        await sleep(blockMs)
      }
    }
  }

  return {
    capability: 'duplex',

    async init() {
      pub = new Redis(url, { maxRetriesPerRequest: null })
      sub = new Redis(url, { maxRetriesPerRequest: null })
      // Surface (once) instead of ioredis's unhandled 'error' event spam;
      // commands keep queueing across its auto-reconnect either way.
      for (const conn of [pub, sub]) {
        let warned = false
        conn.on('error', (err) => {
          if (warned) return
          warned = true
          console.warn('[bread] @breadai/transport-redis: connection error (auto-reconnecting):', err.message)
        })
      }
      // Fail fast on an unreachable broker instead of silently buffering.
      await pub.ping()
      running = true
      loop = readLoop(sub)
    },

    async publish(frame: BusFrame): Promise<void> {
      const { pub: p } = requireStarted()
      const k = key(frame.runId)
      await p
        .pipeline()
        .xadd(k, 'MAXLEN', '~', maxLen, '*', 'frame', JSON.stringify({ v: FRAME_VERSION, ...frame }))
        .expire(k, ttlSeconds)
        .exec()
    },

    subscribe(runId: string, afterSeq: number, handler: (frame: BusFrame) => void): Unsubscribe {
      const { pub: p } = requireStarted()
      let s = subs.get(runId)
      if (!s) {
        // Anchor live tailing at the stream's tail AS OF NOW: the XREVRANGE is
        // enqueued on the pub connection synchronously, so per-connection
        // command ordering guarantees it lands before any publish() issued
        // after this call — those frames arrive live, everything already in
        // the stream is instead covered by this call's own replayTo below.
        // ('0-0' for an empty stream: nothing earlier exists by definition.)
        const state: Subscription = {
          handlers: new Set(),
          lastId: null,
          anchor: p
            .xrevrange(key(runId), '+', '-', 'COUNT', 1)
            .then((newest) => {
              if (state.lastId === null) state.lastId = newest[0]?.[0] ?? '0-0'
            })
            .catch(() => {
              if (state.lastId === null) state.lastId = '0-0'
            }),
        }
        s = state
        subs.set(runId, s)
      }
      s.handlers.add(handler)
      // Registered for live delivery above already — safe to replay history now.
      void replayTo(runId, afterSeq, handler)
      return () => {
        s.handlers.delete(handler)
        if (s.handlers.size === 0) subs.delete(runId)
      }
    },

    async close() {
      running = false
      // disconnect() aborts the blocked XREAD so the loop can exit.
      sub?.disconnect()
      await loop?.catch(() => {})
      await pub?.quit().catch(() => {})
      pub = null
      sub = null
      subs.clear()
    },
  }
}
