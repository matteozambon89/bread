import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineHumanTool, defineTool } from '@bread/core'
import type { BreadCrumb, BreadTransport, BusFrame, HumanRequiredEvent, PipelineStep } from '@bread/core'
import {
  collect,
  defineTestAgent,
  makeBread,
  mockErrorModel,
  mockScript,
  mockTextModel,
  mockToolCallModel,
  runCollect,
  stream,
} from '@bread/test-utils'

// A BreadTransport that records every published frame — the assertion surface
// for "the transport view equals the client-visible stream".
function recordingTransport(): { transport: BreadTransport; frames: BusFrame[] } {
  const frames: BusFrame[] = []
  return {
    transport: {
      capability: 'duplex',
      publish: (f) => {
        frames.push(f)
      },
      subscribe: () => () => {},
    },
    frames,
  }
}

describe('choke point — transport view equals the client-visible stream', () => {
  test('publishes exactly the yielded crumbs, in order, for a tool-calling run', async () => {
    const { transport, frames } = recordingTransport()
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockToolCallModel({ toolName: 'tool_add', args: { a: 1, b: 2 }, then: 'done' }),
      config: { transport },
    })
    try {
      const crumbs = await runCollect(bread, 'calc', 'go')
      expect(frames.map((f) => f.crumb.type)).toEqual(crumbs.map((c) => c.type))
      expect(frames.map((f) => f.seq)).toEqual(crumbs.map((c) => c.seq!))
      expect(crumbs.every((c) => c.seq !== undefined)).toBe(true)
    } finally {
      await stop()
    }
  })

  test('seq is per-run monotonic and text:delta carries the watermark', async () => {
    const { transport, frames } = recordingTransport()
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
      config: { transport },
    })
    try {
      const crumbs = await runCollect(bread, 'a', 'go')
      const types = crumbs.map((c) => c.type)
      expect(types).toEqual(['agent:run:start', 'text:delta', 'agent:run:end'])
      // Durable crumbs take fresh seqs; the delta holds the last durable seq.
      // Seq 2 belongs to the aggregated delta entry the log writer flushes at
      // the agent:run:end boundary, so the end crumb takes 3.
      expect(crumbs.map((c) => c.seq)).toEqual([1, 1, 3])
      expect(frames.map((f) => f.seq)).toEqual([1, 1, 3])
    } finally {
      await stop()
    }
  })

  test('mediated sub-agents publish subagent framing, not raw child crumbs', async () => {
    const { transport, frames } = recordingTransport()
    const { bread, stop } = await makeBread({
      agents: {
        parent: defineTestAgent({
          model: 'parent',
          config: { supervisor: { agents: [{ agentId: 'child', visibility: 'mediate' }] } },
        }),
        child: defineTestAgent({ model: 'child' }),
      },
      models: {
        parent: mockScript([{ tool: 'core_delegate', args: { agentId: 'child', input: 'go' } }, { text: 'done' }]),
        child: mockTextModel('sub says hi'),
      },
      config: { transport },
    })
    try {
      const crumbs = await runCollect(bread, 'parent', 'go')
      // The old dual-emission bug: raw child text:delta hit the bus while the
      // generator dropped it, and subagent:* framing never reached the bus.
      expect(frames.map((f) => f.crumb.type)).toEqual(crumbs.map((c) => c.type))
      // The mediated child's own deltas never surface — the only text:delta
      // crumbs belong to the parent composing its answer.
      const deltaAgents = frames
        .filter((f) => f.crumb.type === 'text:delta')
        .map((f) => (f.crumb as { agentId: string }).agentId)
      expect(deltaAgents.every((id) => id === 'parent')).toBe(true)
      expect(frames.map((f) => f.crumb.type)).toContain('subagent:run:start')
      expect(frames.map((f) => f.crumb.type)).toContain('subagent:run:end')
    } finally {
      await stop()
    }
  })

  test('bread.on(\'crumb\') listeners see the canonical stream', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    try {
      const heard: BreadCrumb[] = []
      bread.on('crumb', (c) => heard.push(c))
      const crumbs = await runCollect(bread, 'a', 'go')
      expect(heard.map((c) => c.type)).toEqual(crumbs.map((c) => c.type))
      expect(heard.map((c) => c.seq)).toEqual(crumbs.map((c) => c.seq))
    } finally {
      await stop()
    }
  })

  test('bread.on(\'human:required\') fires when a run suspends', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: { gate: defineTestAgent({ humanTools: [approve] }) },
      model: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'done' }),
    })
    try {
      const events: HumanRequiredEvent[] = []
      bread.on('human:required', (e) => {
        events.push(e as HumanRequiredEvent)
      })
      const crumbs = await runCollect(bread, 'gate', 'go')
      const cp = crumbs.find((c) => c.type === 'human:required')!
      expect(events).toHaveLength(1)
      expect(events[0]!.checkpointId).toBe((cp as { checkpointId: string }).checkpointId)
      expect(events[0]!.toolName).toBe('human_approve')
    } finally {
      await stop()
    }
  })

  test('sync-mode runs publish to the bus like streamed ones', async () => {
    const { transport, frames } = recordingTransport()
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
      config: { transport },
    })
    try {
      const { output } = await bread.run('a', 'go', { mode: 'sync' })
      expect(output).toBe('hi')
      expect(frames.map((f) => f.crumb.type)).toEqual(['agent:run:start', 'text:delta', 'agent:run:end'])
    } finally {
      await stop()
    }
  })

  test('bread.runPipeline streams step framing and publishes it to the bus', async () => {
    const { transport, frames } = recordingTransport()
    const steps: PipelineStep[] = [{ type: 'agent', agentId: 'a' }]
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
      config: { transport, pipelines: { p: steps } },
    })
    try {
      const crumbs = await collect(bread.runPipeline('p', 'x'))
      expect(crumbs.map((c) => c.type)).toEqual([
        'pipeline:step:start',
        'agent:run:start',
        'text:delta',
        'agent:run:end',
        'pipeline:step:end',
      ])
      expect(frames.map((f) => f.crumb.type)).toEqual(crumbs.map((c) => c.type))
      // Step crumbs sequence under the step's own runId, agent crumbs under theirs.
      expect(frames[0]!.runId).toBe('p:0')
      expect(frames[0]!.seq).toBe(1)
      expect(frames[4]!.runId).toBe('p:0')
      expect(frames[4]!.seq).toBe(2)
    } finally {
      await stop()
    }
  })

  test('runPipeline throws PIPELINE_NOT_FOUND for an unknown id', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    try {
      expect(() => bread.runPipeline('nope', 'x')).toThrow('Pipeline not found: "nope"')
    } finally {
      await stop()
    }
  })

  test('error crumbs cross the bus in wire form and stay sanitizable', async () => {
    const { transport, frames } = recordingTransport()
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockErrorModel('model exploded'),
      config: { transport },
    })
    try {
      await expect(runCollect(bread, 'a', 'go')).rejects.toThrow('model exploded')
      const errFrame = frames.find((f) => f.crumb.type === 'agent:error')!
      expect(errFrame).toBeDefined()
      const wire = (errFrame.crumb as { error: unknown }).error as { name: string; message: string }
      // Wire form is a plain object (JSON-safe), not a live Error instance.
      expect(wire instanceof Error).toBe(false)
      expect(wire.name).toBe('BreadError')
      expect(wire.message).toBe('model exploded')
    } finally {
      await stop()
    }
  })

  test('crumbFilter drops matching crumbs from the transport, not from the yielded stream or the store', async () => {
    const { transport, frames } = recordingTransport()
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
      config: { transport, crumbFilter: (c) => c.type !== 'text:delta' },
    })
    try {
      const crumbs = await runCollect(bread, 'a', 'go')
      const runId = (crumbs[0] as { runId: string }).runId

      // Direct yield: untouched.
      expect(crumbs.map((c) => c.type)).toEqual(['agent:run:start', 'text:delta', 'agent:run:end'])
      // Transport: text:delta dropped.
      expect(frames.map((f) => f.crumb.type)).toEqual(['agent:run:start', 'agent:run:end'])
      // Store: untouched — filtering only gates transport delivery.
      const entries = await bread.store.getCrumbs!(runId)
      expect(entries.map((e) => e.type)).toEqual(['agent:run:start', 'text:delta', 'agent:run:end'])
      // Exposed on the instance for transports' own catch-up replay to apply.
      expect(bread.crumbFilter?.(crumbs[1]!)).toBe(false)
    } finally {
      await stop()
    }
  })

  test('bread.transport exposes the live fabric for passive subscription by runId', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    try {
      const it = stream(bread, 'a', 'go')[Symbol.asyncIterator]()
      const first = await it.next()
      const { runId, seq } = first.value as { runId: string; seq: number }

      // Subscribe mid-run (after the first crumb): only the tail arrives —
      // afterSeq covers what's already been seen, so it isn't replayed.
      const tail: BusFrame[] = []
      const unsub = bread.transport.subscribe!(runId, seq, (f) => tail.push(f))
      while (!(await it.next()).done) {
        // drain
      }
      unsub()
      expect(tail.map((f) => f.crumb.type)).toEqual(['text:delta', 'agent:run:end'])
    } finally {
      await stop()
    }
  })
})
