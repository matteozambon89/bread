import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineHumanTool } from '@breadai/core'
import type { BreadStore } from '@breadai/core'
import { store } from '@breadai/store-memory'
import { transport as httpSseTransport } from '@breadai/transport-http-sse'
import {
  defineTestAgent,
  makeServer,
  mockTextModel,
  mockToolCallModel,
  parseSse,
  readSse,
} from '@breadai/test-utils'

const json = { 'content-type': 'application/json' }

const gateAgent = () => {
  const approve = defineHumanTool('approve', z.object({ question: z.string() }))
  return defineTestAgent({ humanTools: [approve] })
}
const gateModel = () =>
  mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved' })

// Incrementally reads an SSE body until its accumulated text contains
// `marker` — the synchronization point for "the passive route is live".
async function readBodyUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  acc: { text: string },
  marker: string,
): Promise<void> {
  const decoder = new TextDecoder()
  while (!acc.text.includes(marker)) {
    const { done, value } = await reader.read()
    if (done) return
    acc.text += decoder.decode(value, { stream: true })
  }
}

async function readBodyToEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  acc: { text: string },
): Promise<void> {
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    acc.text += decoder.decode(value, { stream: true })
  }
}

describe('server — SSE ids on run routes', () => {
  test('POST run events carry id: fields matching the crumb seq', async () => {
    const { app, stop } = await makeServer({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    try {
      const res = await app.request('/agents/a/run', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ input: 'go' }),
      })
      const events = await readSse(res)
      expect(events.map((e) => e.type)).toEqual(['agent:run:start', 'text:delta', 'agent:run:end'])
      expect(events.map((e) => e.id)).toEqual([1, 1, 3])
      for (const e of events) expect((e.payload as { seq: number }).seq).toBe(e.id!)
    } finally {
      await stop()
    }
  })
})

describe('server — GET /runs/:runId/stream', () => {
  test('replays a finished run from the crumb log and honours Last-Event-ID', async () => {
    const { app, stop } = await makeServer({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hello'),
    })
    try {
      const runRes = await app.request('/agents/a/run', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ input: 'go' }),
      })
      const runEvents = await readSse(runRes)
      const runId = (runEvents[0]!.payload as { runId: string }).runId

      // Full catch-up: replay closes by itself at the terminal crumb.
      const full = await readSse(await app.request(`/runs/${runId}/stream`))
      expect(full.map((e) => [e.type, e.id])).toEqual([
        ['agent:run:start', 1],
        ['text:delta', 2],
        ['agent:run:end', 3],
      ])
      // The aggregated delta replays as one ordinary (larger) text:delta.
      expect((full[1]!.payload as { delta: string }).delta).toBe('hello')

      // Reconnect after seq 1: only the tail replays.
      const tail = await readSse(
        await app.request(`/runs/${runId}/stream`, { headers: { 'Last-Event-ID': '1' } }),
      )
      expect(tail.map((e) => e.id)).toEqual([2, 3])

      // ?after= is the header's query fallback.
      const viaQuery = await readSse(await app.request(`/runs/${runId}/stream?after=2`))
      expect(viaQuery.map((e) => e.id)).toEqual([3])
    } finally {
      await stop()
    }
  })

  test('rejects a non-numeric Last-Event-ID', async () => {
    const { app, stop } = await makeServer({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    try {
      const res = await app.request('/runs/some-run/stream', {
        headers: { 'Last-Event-ID': 'bogus' },
      })
      expect(res.status).toBe(400)
    } finally {
      await stop()
    }
  })

  test('a suspended run resumed on container A reaches a passive subscriber on container B', async () => {
    // Two replicas of one app: same store (truth) + same transport (liveness),
    // separate BreadInstances and Hono apps.
    const testStore = store()
    const transport = httpSseTransport()
    const a = await makeServer({
      agents: { gate: gateAgent() },
      model: gateModel(),
      config: { store: testStore, transport },
    })
    const b = await makeServer({
      agents: { gate: gateAgent() },
      model: mockTextModel('unused'),
      config: { store: testStore, transport },
    })
    try {
      // Run on A until it suspends at human:required.
      const runEvents = await readSse(
        await a.app.request('/agents/gate/run', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ input: 'go' }),
        }),
      )
      const runId = (runEvents[0]!.payload as { runId: string }).runId
      const human = runEvents.find((e) => e.type === 'human:required')!
      const checkpointId = (human.payload as { checkpointId: string }).checkpointId

      // Passive-subscribe on B: catch-up replays the suspended history and the
      // stream stays open across human:required.
      const streamRes = await b.app.request(`/runs/${runId}/stream`)
      const reader = streamRes.body!.getReader()
      const acc = { text: '' }
      await readBodyUntil(reader, acc, 'human:required')

      // Resume on A; the continuation must flow A → bus → B.
      const contEvents = await readSse(
        await a.app.request(`/resume/${checkpointId}`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ response: { approved: true } }),
        }),
      )
      expect(contEvents.map((e) => e.type)).toContain('agent:run:end')

      await readBodyToEnd(reader, acc)
      const events = parseSse(acc.text)
      expect(events.map((e) => e.type)).toEqual([
        'agent:run:start',
        'human:required',
        'human:resumed',
        'text:delta',
        'agent:run:end',
      ])
      const text = events
        .filter((e) => e.type === 'text:delta')
        .map((e) => (e.payload as { delta: string }).delta)
        .join('')
      expect(text).toBe('approved')
      // Durable ids strictly increase across the suspend/resume boundary.
      const durableIds = events.filter((e) => e.type !== 'text:delta').map((e) => e.id!)
      expect(durableIds).toEqual([...durableIds].sort((x, y) => x - y))
      expect(new Set(durableIds).size).toBe(durableIds.length)
    } finally {
      await a.stop()
      await b.stop()
    }
  })

  test('degrades to live-tail-only when the store lacks the crumb log', async () => {
    const base = store()
    const bare: BreadStore = { ...base }
    delete (bare as Partial<BreadStore>).getCrumbs
    delete (bare as Partial<BreadStore>).appendCrumbs
    delete (bare as Partial<BreadStore>).getMaxCrumbSeq

    const { app, stop } = await makeServer({
      agents: { gate: gateAgent() },
      model: gateModel(),
      config: { store: bare },
    })
    try {
      const runEvents = await readSse(
        await app.request('/agents/gate/run', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ input: 'go' }),
        }),
      )
      const runId = (runEvents[0]!.payload as { runId: string }).runId
      const human = runEvents.find((e) => e.type === 'human:required')!
      const checkpointId = (human.payload as { checkpointId: string }).checkpointId

      // No catch-up is possible; the `retry:` preamble marks the subscription
      // as live before any frame arrives.
      const streamRes = await app.request(`/runs/${runId}/stream`)
      const reader = streamRes.body!.getReader()
      const acc = { text: '' }
      await readBodyUntil(reader, acc, 'retry:')

      await readSse(
        await app.request(`/resume/${checkpointId}`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ response: { approved: true } }),
        }),
      )

      await readBodyToEnd(reader, acc)
      const events = parseSse(acc.text)
      // Live frames only — nothing from before the subscription.
      expect(events.map((e) => e.type)).toEqual(['human:resumed', 'text:delta', 'agent:run:end'])
    } finally {
      await stop()
    }
  })
})
