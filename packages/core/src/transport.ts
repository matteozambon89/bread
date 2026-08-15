import type { BreadCrumb, BreadInstance } from './types.js'
import { BreadError } from './types.js'

// The transport is the crumb fabric between replicas of one bread app (and,
// once a duplex transport carries the Bread protocol over a network — see
// protocol.ts — between a bread instance and a remote caller): the instance
// executing a run publishes every client-visible crumb as a frame; any
// subscriber can tail a run's stream, with a bounded seq-based replay
// guarantee for reconnects. The store remains the durable, unbounded source
// of truth; a transport's own replay is a bounded, implementation-defined
// convenience on top (see each transport's own retention policy).

// One crumb on the fabric. `seq` is the durable log position: for non-delta
// crumbs it is the crumb's own log seq; for `text:delta` crumbs it is the
// watermark — the seq of the last durable entry before this delta (deltas are
// aggregated before persisting, so they hold no log position of their own).
export interface BusFrame {
  runId: string
  seq: number
  crumb: BreadCrumb
}

export type Unsubscribe = () => void

// `sink`: publish-only, no subscribe (e.g. stdout rendering — nothing "tails"
// a sink). `duplex`: publish + subscribe with the replay guarantee below.
export type TransportCapability = 'duplex' | 'sink'

// Contract every transport implementation (embedded Stream, Redis Streams,
// HTTP chunked/SSE, stdout, …) must satisfy:
// - delivery is at-least-once; duplicates are possible around reconnects
// - publish order is preserved per runId; no ordering across runs
// - frames must survive JSON round-trips (see toWireCrumb/fromWireCrumb)
// - a handler error must never propagate to the publisher
// - duplex `subscribe`: replays frames with `seq > afterSeq` still within the
//   transport's own retention window (implementation-defined bound — no
//   durability guarantee; that's the store's job), then tails live
export interface BreadTransport {
  readonly capability: TransportCapability
  publish(frame: BusFrame): void | Promise<void>
  subscribe?(runId: string, afterSeq: number, handler: (frame: BusFrame) => void): Unsubscribe
  init?(): Promise<void>
  close?(): Promise<void>
  // Present only on transports that can serve as an HTTP ingress producer.
  // Implemented purely against the public BreadInstance surface (run/resume/
  // runPipeline/store.getCrumbs/transport.subscribe) — never anything private
  // — the same discipline BreadPlugin.routes already follows. `app: unknown`
  // keeps core Hono-free, matching BreadPlugin.routes's existing pattern.
  mount?(app: unknown, bread: BreadInstance): void
}

// Reference conformer: the default single-process transport. Keeps a bounded
// per-run replay buffer so a `subscribe(runId, afterSeq, handler)` call
// replays whatever's still buffered before tailing live — real replay, not a
// no-op, for the common case of a client reconnecting within the same
// process (a full restart still needs the store's durable crumb log).
const MAX_FRAMES_PER_RUN = 1000
const MAX_TRACKED_RUNS = 1000

export function streamTransport(): BreadTransport {
  const subscribers = new Map<string, Set<(frame: BusFrame) => void>>()
  // Insertion order doubles as LRU order: touching a run re-inserts it last.
  const buffers = new Map<string, BusFrame[]>()

  function touch(runId: string): BusFrame[] {
    let buf = buffers.get(runId)
    if (buf) {
      buffers.delete(runId)
    } else {
      buf = []
      if (buffers.size >= MAX_TRACKED_RUNS) {
        const oldest = buffers.keys().next().value
        if (oldest !== undefined) buffers.delete(oldest)
      }
    }
    buffers.set(runId, buf)
    return buf
  }

  return {
    capability: 'duplex',

    publish(frame: BusFrame): void {
      const buf = touch(frame.runId)
      buf.push(frame)
      if (buf.length > MAX_FRAMES_PER_RUN) buf.splice(0, buf.length - MAX_FRAMES_PER_RUN)

      const set = subscribers.get(frame.runId)
      if (!set) return
      for (const handler of set) {
        try {
          handler(frame)
        } catch {
          // handler errors must not propagate to the publisher
        }
      }
    },

    subscribe(runId: string, afterSeq: number, handler: (frame: BusFrame) => void): Unsubscribe {
      for (const frame of buffers.get(runId) ?? []) {
        if (frame.seq > afterSeq) {
          try {
            handler(frame)
          } catch {
            // handler errors must not propagate to the publisher
          }
        }
      }

      let set = subscribers.get(runId)
      if (!set) {
        set = new Set()
        subscribers.set(runId, set)
      }
      set.add(handler)
      return () => {
        set.delete(handler)
        if (set.size === 0) subscribers.delete(runId)
      }
    },
  }
}

interface WireError {
  name: 'BreadError'
  code: string
  message: string
  context?: Record<string, unknown> | undefined
}

// `tool:error` / `agent:error` crumbs carry live BreadError instances, which
// don't survive JSON (Error.message is non-enumerable; cause/stack can hold
// non-JSON provider objects). toWireCrumb flattens the error to
// { name, code, message, context }; fromWireCrumb rebuilds a real BreadError
// so replayed crumbs go through the same instanceof-based sanitization as
// live ones. All other crumb payloads are already plain JSON by contract.
export function toWireCrumb(crumb: BreadCrumb): BreadCrumb {
  if (!('error' in crumb) || !(crumb.error instanceof Error)) return crumb
  const err = crumb.error
  const wire: WireError = {
    name: 'BreadError',
    code: err instanceof BreadError ? err.code : 'AGENT_ERROR',
    message: err.message,
    ...(err instanceof BreadError && err.context ? { context: err.context } : {}),
  }
  return { ...crumb, error: wire } as unknown as BreadCrumb
}

export function fromWireCrumb(crumb: BreadCrumb): BreadCrumb {
  if (!('error' in crumb) || crumb.error instanceof Error) return crumb
  const wire = crumb.error as unknown as WireError
  if (!wire || typeof wire !== 'object' || typeof wire.message !== 'string') return crumb
  return {
    ...crumb,
    error: new BreadError(wire.message, wire.code ?? 'AGENT_ERROR', wire.context),
  } as BreadCrumb
}
