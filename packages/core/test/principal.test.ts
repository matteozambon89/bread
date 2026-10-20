import { describe, expect, test } from 'bun:test'
import { defineHumanTool, defineTask, defineTool } from '@breadai/core'
import type { CancellableOptions, HumanRequiredCrumb, Principal } from '@breadai/core'
import {
  collect,
  defineTestAgent,
  makeBread,
  mockObjectModel,
  mockScript,
  mockTextModel,
  mockToolCallModel,
  runCollect,
} from '@breadai/test-utils'
import { z } from 'zod'

const host: Principal = { iss: 'https://idp.example', sub: 'user-1', tenant: 'acme', roles: [' b ', 'a', 'a'] }
const spoof: Principal = { iss: 'https://evil.example', sub: 'spoof' }

function probe(seen: Array<Principal | undefined>) {
  return defineTool({
    name: 'probe',
    description: 'Record the run principal',
    schema: z.object({
      principal: z.object({ iss: z.string(), sub: z.string() }).optional(),
    }),
    execute: async (_args, ctx) => {
      seen.push(ctx.principal)
      return { ok: true }
    },
  })
}

function noteTask(seen: Array<Principal | undefined>) {
  return defineTask({
    name: 'note',
    description: 'Record the task principal',
    model: { provider: 'mock', model: 'task' },
    instructions: 'note',
    schema: z.object({
      principal: z.object({ iss: z.string(), sub: z.string() }).optional(),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    hooks: {
      async beforeRun(c) {
        seen.push(c.principal)
        return { action: 'shortCircuit', output: { ok: true } }
      },
    },
  })
}

describe('principal', () => {
  test('a run started with a principal exposes that principal on the tool context', async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
    })
    try {
      await runCollect(bread, 'agent', 'go', { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('a run started without a principal leaves principal undefined', async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
    })
    try {
      await runCollect(bread, 'agent', 'go')
      expect(seen).toEqual([undefined])
    } finally {
      await stop()
    }
  })

  test("a delegated sub-agent sees the supervisor's principal, not a value from the delegate arguments", async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'worker' }] } },
        }),
        worker: defineTestAgent({ model: 'worker', tools: [probe(seen)] }),
      },
      models: {
        boss: mockScript([
          { tool: 'core_delegate', args: { agentId: 'worker', input: { principal: spoof } } },
          { text: 'done' },
        ]),
        worker: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'ok' }),
      },
    })
    try {
      await runCollect(bread, 'boss', 'go', { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test("a pipeline step sees the pipeline's principal", async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { step: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
      config: { pipelines: { p: [{ type: 'agent', agentId: 'step' }] } },
    })
    try {
      await collect(bread.runPipeline('p', { principal: spoof }, { principal: host }))
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test("a loop iteration's inner agent sees the host run's principal", async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['worker'], maxIterations: 1 } },
        }),
        worker: defineTestAgent({ model: 'worker', tools: [probe(seen)] }),
      },
      models: {
        host: mockScript([
          { tool: 'core_start_loop', args: { pipeline: ['worker'], input: { principal: spoof } } },
          { text: 'done' },
        ]),
        worker: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'ok' }),
      },
    })
    try {
      await runCollect(bread, 'host', 'go', { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test("a task tool sees the host tool context's principal", async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent({ config: { tasks: ['note'] } }) },
      tasks: { note: noteTask(seen) },
      models: {
        default: mockScript([
          { tool: 'task_note', args: { principal: spoof } },
          { text: 'done' },
        ]),
        task: mockObjectModel({ ok: true }),
      },
    })
    try {
      await runCollect(bread, 'agent', 'go', { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('runTask with a principal exposes it on the task tool context', async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent() },
      tasks: { note: noteTask(seen) },
      model: mockTextModel('unused'),
    })
    try {
      await bread.runTask('note', { principal: spoof }, { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('a suspended run restores the same principal on resume', async () => {
    const seen: Array<Principal | undefined> = []
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ tools: [probe(seen)], humanTools: [approve] }),
      },
      model: mockScript([
        { tool: 'human_approve', args: { question: 'ok?' } },
        { tool: 'tool_probe', args: { principal: spoof } },
        { text: 'done' },
      ]),
    })
    try {
      const first = await runCollect(bread, 'gate', 'go', { principal: host })
      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      await collect(bread.resume(cp.checkpointId, { ok: true }))
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('a resume caller cannot replace the stored principal', async () => {
    const seen: Array<Principal | undefined> = []
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ tools: [probe(seen)], humanTools: [approve] }),
      },
      model: mockScript([
        { tool: 'human_approve', args: { question: 'ok?' } },
        { tool: 'tool_probe', args: { principal: spoof } },
        { text: 'done' },
      ]),
    })
    try {
      const first = await runCollect(bread, 'gate', 'go', { principal: host })
      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      await collect(bread.resume(cp.checkpointId, { ok: true }, { principal: spoof } as CancellableOptions))
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })
})
