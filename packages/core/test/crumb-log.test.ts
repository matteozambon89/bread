import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineHumanTool } from '@breadai/core'
import type { BreadCrumb, BreadStore } from '@breadai/core'
import { store } from '@breadai/store-memory'
import { collect, defineTestAgent, makeBread, mockTextModel, mockToolCallModel, runCollect } from '@breadai/test-utils'
import { createCrumbLogWriter } from '../src/crumb-log.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function start(runId: string): BreadCrumb {
  return { type: 'agent:run:start', agentId: 'a', runId, sessionId: 's', timestamp: 1, input: 'go' }
}

function delta(runId: string, text: string): BreadCrumb {
  return { type: 'text:delta', agentId: 'a', runId, sessionId: 's', timestamp: 1, delta: text }
}

function reasoningDelta(runId: string, text: string): BreadCrumb {
  return { type: 'reasoning:delta', agentId: 'a', runId, sessionId: 's', timestamp: 1, delta: text }
}

function end(runId: string): BreadCrumb {
  return { type: 'agent:run:end', agentId: 'a', runId, sessionId: 's', timestamp: 1, output: 'ok', durationMs: 1 }
}

async function seededStore(): Promise<BreadStore> {
  const testStore = store()
  await testStore.createSession({ id: 's' })
  return testStore
}

describe('CrumbLogWriter', () => {
  test('aggregates consecutive deltas into one entry flushed at a non-delta boundary', async () => {
    const store = await seededStore()
    const writer = createCrumbLogWriter({ store })

    const s = await writer.process(start('r'))
    const d1 = await writer.process(delta('r', 'a'))
    const d2 = await writer.process(delta('r', 'b'))
    const d3 = await writer.process(delta('r', 'c'))
    const e = await writer.process(end('r'))
    await writer.finalize()

    // Live crumbs: durable ones take fresh seqs, deltas carry the watermark.
    expect([s.seq, d1.seq, d2.seq, d3.seq, e.seq]).toEqual([1, 1, 1, 1, 3])

    const entries = await store.getCrumbs!('r')
    expect(entries.map((en) => [en.type, en.seq])).toEqual([
      ['agent:run:start', 1],
      ['text:delta', 2],
      ['agent:run:end', 3],
    ])
    expect((entries[1]!.crumb as { delta: string }).delta).toBe('abc')
  })

  test('flushes the window when it reaches maxBufferBytes', async () => {
    const store = await seededStore()
    const writer = createCrumbLogWriter({ store, maxBufferBytes: 4 })

    await writer.process(delta('r', 'aa'))
    await writer.process(delta('r', 'bb')) // 4 bytes — flush
    const tail = await writer.process(delta('r', 'cc'))
    await writer.finalize()

    expect(tail.seq).toBe(1) // watermark = the flushed aggregate's seq
    const entries = await store.getCrumbs!('r')
    expect(entries.map((e) => [(e.crumb as { delta: string }).delta, e.seq])).toEqual([
      ['aabb', 1],
      ['cc', 2],
    ])
  })

  test('flushes the window after maxBufferMs of age', async () => {
    const store = await seededStore()
    const writer = createCrumbLogWriter({ store, maxBufferMs: 20 })

    await writer.process(delta('r', 'slow'))
    await sleep(60)

    const entries = await store.getCrumbs!('r')
    expect(entries.map((e) => (e.crumb as { delta: string }).delta)).toEqual(['slow'])
    await writer.finalize()
  })

  test('seeds the counter from the log so continuations extend the original numbering', async () => {
    const store = await seededStore()
    await store.appendCrumbs!([
      { runId: 'r', seq: 5, sessionId: 's', agentId: 'a', type: 'agent:run:start', crumb: start('r'), createdAt: 1 },
    ])

    const writer = createCrumbLogWriter({ store })
    const c = await writer.process(end('r'))
    await writer.finalize()

    expect(c.seq).toBe(6)
    expect(await store.getMaxCrumbSeq!('r')).toBe(6)
  })

  test('a failed store write disables logging for the run without failing the stream', async () => {
    const store = await seededStore()
    const broken: BreadStore = {
      ...store,
      appendCrumbs: async () => {
        throw new Error('disk full')
      },
    }
    const writer = createCrumbLogWriter({ store: broken })

    const s = await writer.process(start('r'))
    const e = await writer.process(end('r'))
    await writer.finalize() // resolves — the failure is swallowed after a warning

    expect([s.seq, e.seq]).toEqual([1, 2]) // sequencing continues
    expect(await store.getCrumbs!('r')).toEqual([])
  })

  test('sequences pipeline:step crumbs without persisting them', async () => {
    const store = await seededStore()
    const writer = createCrumbLogWriter({ store })

    const c = await writer.process({
      type: 'pipeline:step:start',
      pipelineId: 'p',
      stepIndex: 0,
      agentId: 'a',
      runId: 'p:0',
      timestamp: 1,
    })
    await writer.finalize()

    expect(c.seq).toBe(1)
    expect(await store.getCrumbs!('p:0')).toEqual([])
  })

  test('reasoning and text deltas aggregate into independent windowed entries', async () => {
    const store = await seededStore()
    const writer = createCrumbLogWriter({ store })

    await writer.process(start('r'))
    // Interleaved: reasoning window and text window must not mix content.
    await writer.process(reasoningDelta('r', 'thinking... '))
    await writer.process(delta('r', 'Hel'))
    await writer.process(reasoningDelta('r', 'done.'))
    await writer.process(delta('r', 'lo'))
    await writer.process(end('r'))
    await writer.finalize()

    const entries = await store.getCrumbs!('r')
    expect(entries.map((e) => e.type)).toEqual([
      'agent:run:start',
      'reasoning:delta',
      'text:delta',
      'agent:run:end',
    ])
    expect((entries[1]!.crumb as { delta: string }).delta).toBe('thinking... done.')
    expect((entries[2]!.crumb as { delta: string }).delta).toBe('Hello')
  })

  test('sequences without persisting when the store lacks the log methods', async () => {
    const store = await seededStore()
    const bare: BreadStore = { ...store }
    delete (bare as Partial<BreadStore>).appendCrumbs
    delete (bare as Partial<BreadStore>).getCrumbs
    delete (bare as Partial<BreadStore>).getMaxCrumbSeq

    const writer = createCrumbLogWriter({ store: bare })
    const s = await writer.process(start('r'))
    const d = await writer.process(delta('r', 'x'))
    const e = await writer.process(end('r'))
    await writer.finalize()

    // No window buffering without a log: deltas are pure watermarks.
    expect([s.seq, d.seq, e.seq]).toEqual([1, 1, 2])
  })
})

describe('crumb log — end to end through the instance', () => {
  test('an agent run persists its client-visible history with aggregated deltas', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    try {
      const crumbs = await runCollect(bread, 'a', 'go')
      const runId = (crumbs[0] as { runId: string }).runId

      const entries = await bread.store.getCrumbs!(runId)
      expect(entries.map((e) => [e.type, e.seq])).toEqual([
        ['agent:run:start', 1],
        ['text:delta', 2],
        ['agent:run:end', 3],
      ])
      expect((entries[1]!.crumb as { delta: string }).delta).toBe('hi')
      expect(await bread.store.getMaxCrumbSeq!(runId)).toBe(3)
    } finally {
      await stop()
    }
  })

  test('a resumed run\'s continuation extends the original run\'s log', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: { gate: defineTestAgent({ humanTools: [approve] }) },
      model: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'done' }),
    })
    try {
      const first = await runCollect(bread, 'gate', 'go')
      const runId = (first[0] as { runId: string }).runId
      const cp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
      const before = await bread.store.getMaxCrumbSeq!(runId)
      expect(before).toBeGreaterThan(0)

      await collect(bread.resume(cp.checkpointId, { approved: true }))

      const entries = await bread.store.getCrumbs!(runId)
      const seqs = entries.map((e) => e.seq)
      // One continuous, strictly increasing log across suspension and resume.
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size).toBe(seqs.length)
      const types = entries.map((e) => e.type)
      expect(types).toContain('human:required')
      expect(types).toContain('human:resumed')
      expect(types).toContain('agent:run:end')
      expect(entries.filter((e) => e.seq <= before).length).toBe(before)
    } finally {
      await stop()
    }
  })
})
