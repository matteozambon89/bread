import assert from 'node:assert/strict'
import type { BreadTransport, BusFrame } from '@bread/core'

// A behavioral contract every duplex BreadTransport implementation must
// satisfy, expressed as runner-agnostic cases (node:assert) like the store
// contract. Delivery may be asynchronous (Redis round-trips), so cases
// synchronize on observed frames via `waitFor` instead of assuming
// synchronous dispatch.

export interface TransportCase {
  name: string
  // Cases tagged `replay` exercise the seq-based afterSeq replay guarantee.
  // Skip them (via `skipReplayReason`) for a duplex transport that hasn't
  // implemented real replay yet — see `runTransportContract`.
  replay?: true
  fn: (transport: BreadTransport) => Promise<void>
}

/** Polls until `cond` holds; throws after `timeoutMs` naming the case's expectation. */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`transport contract: timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function frame(runId: string, seq: number): BusFrame {
  return {
    runId,
    seq,
    crumb: {
      type: 'text:delta',
      agentId: 'a',
      runId,
      sessionId: 's',
      timestamp: 1,
      delta: `d${seq}`,
      seq,
    },
  }
}

// Every case in this suite targets a duplex transport — asserts loudly if
// handed one without `subscribe` instead of silently no-op'ing.
function subscribe(
  transport: BreadTransport,
  runId: string,
  afterSeq: number,
  handler: (frame: BusFrame) => void,
) {
  if (!transport.subscribe) {
    throw new Error('transport contract: transport has no subscribe() — is it actually duplex?')
  }
  return transport.subscribe(runId, afterSeq, handler)
}

export function transportContractCases(): TransportCase[] {
  return [
    {
      name: 'delivers published frames to a subscriber of that run',
      fn: async (transport) => {
        const got: BusFrame[] = []
        subscribe(transport, 'r1', 0, (f) => got.push(f))
        await transport.publish(frame('r1', 1))
        await waitFor(() => got.length === 1, 'one frame')
        assert.equal(got[0]!.runId, 'r1')
        assert.equal(got[0]!.seq, 1)
        assert.deepEqual(got[0]!.crumb, frame('r1', 1).crumb)
      },
    },
    {
      name: 'preserves publish order per run',
      fn: async (transport) => {
        const got: number[] = []
        subscribe(transport, 'r1', 0, (f) => got.push(f.seq))
        for (let n = 1; n <= 5; n++) await transport.publish(frame('r1', n))
        await waitFor(() => got.length === 5, 'five frames')
        assert.deepEqual(got, [1, 2, 3, 4, 5])
      },
    },
    {
      name: 'broadcasts one frame to every subscriber of the run',
      fn: async (transport) => {
        let a = 0
        let b = 0
        subscribe(transport, 'r1', 0, () => a++)
        subscribe(transport, 'r1', 0, () => b++)
        await transport.publish(frame('r1', 1))
        await waitFor(() => a === 1 && b === 1, 'both subscribers')
      },
    },
    {
      name: 'isolates runs — a subscriber never sees another run\'s frames',
      fn: async (transport) => {
        const r1: number[] = []
        const r2: number[] = []
        subscribe(transport, 'r1', 0, (f) => r1.push(f.seq))
        subscribe(transport, 'r2', 0, (f) => r2.push(f.seq))
        await transport.publish(frame('r2', 1))
        await transport.publish(frame('r1', 1))
        await waitFor(() => r1.length === 1 && r2.length === 1, 'both runs\' frames')
        assert.deepEqual(r1, [1])
        assert.deepEqual(r2, [1])
      },
    },
    {
      name: 'unsubscribe stops delivery',
      fn: async (transport) => {
        const stopped: number[] = []
        const live: number[] = []
        const unsub = subscribe(transport, 'r1', 0, (f) => stopped.push(f.seq))
        subscribe(transport, 'r1', 0, (f) => live.push(f.seq))
        await transport.publish(frame('r1', 1))
        await waitFor(() => stopped.length === 1 && live.length === 1, 'first frame')
        unsub()
        await transport.publish(frame('r1', 2))
        // The still-live sibling sequences the second frame's arrival.
        await waitFor(() => live.length === 2, 'second frame on the live subscriber')
        assert.deepEqual(stopped, [1])
      },
    },
    {
      name: 'a throwing handler neither reaches the publisher nor starves siblings',
      fn: async (transport) => {
        const ok: number[] = []
        subscribe(transport, 'r1', 0, () => {
          throw new Error('bad handler')
        })
        subscribe(transport, 'r1', 0, (f) => ok.push(f.seq))
        await transport.publish(frame('r1', 1))
        await transport.publish(frame('r1', 2))
        await waitFor(() => ok.length === 2, 'both frames on the healthy subscriber')
        assert.deepEqual(ok, [1, 2])
      },
    },
    {
      name: 'subscribing with afterSeq at the current tip skips frames already covered',
      fn: async (transport) => {
        await transport.publish(frame('r1', 1))
        const got: number[] = []
        // Simulates a real client: "I already have everything through seq 1."
        subscribe(transport, 'r1', 1, (f) => got.push(f.seq))
        // A distributed transport may go live asynchronously — keep publishing
        // fresh frames until one is observed, proving the subscription is
        // active, then assert the already-covered frame never leaked in.
        let seq = 2
        const deadline = Date.now() + 5000
        while (got.length === 0) {
          if (Date.now() > deadline) {
            throw new Error('transport contract: timed out waiting for the subscription to go live')
          }
          await transport.publish(frame('r1', seq++))
          await new Promise((r) => setTimeout(r, 25))
        }
        assert.ok(!got.includes(1), `frame already covered by afterSeq leaked in: ${got}`)
      },
    },
    {
      name: 'afterSeq=0 replays every retained frame, in order, before tailing live',
      replay: true,
      fn: async (transport) => {
        await transport.publish(frame('r1', 1))
        await transport.publish(frame('r1', 2))
        const got: number[] = []
        subscribe(transport, 'r1', 0, (f) => got.push(f.seq))
        await waitFor(() => got.length >= 2, 'the two retained frames to replay')
        assert.deepEqual(got.slice(0, 2), [1, 2])
        await transport.publish(frame('r1', 3))
        await waitFor(() => got.length === 3, 'the live frame after replay')
        assert.deepEqual(got, [1, 2, 3])
      },
    },
    {
      name: 'afterSeq=N replays only frames retained after N',
      replay: true,
      fn: async (transport) => {
        await transport.publish(frame('r1', 1))
        await transport.publish(frame('r1', 2))
        await transport.publish(frame('r1', 3))
        const got: number[] = []
        subscribe(transport, 'r1', 2, (f) => got.push(f.seq))
        await waitFor(() => got.length >= 1, 'the one frame after seq 2 to replay')
        assert.deepEqual(got, [3])
      },
    },
  ]
}

/**
 * Registers the contract with `bun:test`. Per case: `makeTransport()` builds
 * a fresh transport (init() is awaited when present), the case runs, then
 * close() tears it down.
 *
 * - `skipReason` registers every case as visibly skipped (e.g. no Redis available).
 * - `skipReplayReason` registers only the `replay`-tagged cases as visibly
 *   skipped — for a duplex transport that declares the capability but hasn't
 *   implemented real seq-based replay yet.
 */
export function runTransportContract(
  name: string,
  makeTransport: () => Promise<BreadTransport> | BreadTransport,
  opts: { skipReason?: string; skipReplayReason?: string } = {},
): void {
  // Lazy require keeps this module importable under node:test.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { describe, test } = require('bun:test') as typeof import('bun:test')

  describe(`transport contract — ${name}`, () => {
    for (const c of transportContractCases()) {
      if (opts.skipReason) {
        test.skip(`${c.name} (${opts.skipReason})`, () => {})
        continue
      }
      if (c.replay && opts.skipReplayReason) {
        test.skip(`${c.name} (${opts.skipReplayReason})`, () => {})
        continue
      }
      test(c.name, async () => {
        const transport = await makeTransport()
        await transport.init?.()
        try {
          await c.fn(transport)
        } finally {
          await transport.close?.()
        }
      })
    }
  })
}
