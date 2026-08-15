import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { BreadError, defineHumanTool, defineTool } from '@breadai/core'
import type { AgentErrorCrumb, BreadCrumb, BreadInstance, HumanRequiredCrumb } from '@breadai/core'
import { store } from '@breadai/store-memory'
import {
  collect,
  defineTestAgent,
  makeBread,
  mockErrorModel,
  mockScript,
  mockStreamErrorPartModel,
  mockTextModel,
  runCollect,
  stream,
} from '@breadai/test-utils'

// The runner catches errors thrown during a run — here a model-resolution
// failure (unknown provider) — emits an `agent:error` crumb, and rethrows.
// Errors the AI SDK surfaces as in-band `error` *stream parts* rethrow into
// the same catch (second describe below).
describe('runner — error path', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ bread, stop } = await makeBread({
      agents: {
        broken: defineTestAgent({ config: { model: { provider: 'ghost', model: 'x' } } }),
      },
      model: mockTextModel('unused'),
    }))
  })

  afterEach(() => stop())

  test('emits an agent:error crumb and rethrows when the model cannot resolve', async () => {
    const crumbs: BreadCrumb[] = []
    await expect(
      (async () => {
        for await (const c of stream(bread, 'broken', 'go')) crumbs.push(c)
      })(),
    ).rejects.toThrow()
    const err = crumbs.find((c) => c.type === 'agent:error') as AgentErrorCrumb | undefined
    expect(err).toBeDefined()
    expect(err!.agentId).toBe('broken')
    expect(err!.error.code).toBe('UNKNOWN_PROVIDER')
  })
})

describe('runner — in-band error stream part', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ bread, stop } = await makeBread({
      agents: { flaky: defineTestAgent() },
      model: mockStreamErrorPartModel('provider hiccup'),
    }))
  })

  afterEach(() => stop())

  test('fails the run instead of succeeding with truncated text', async () => {
    const crumbs: BreadCrumb[] = []
    await expect(
      (async () => {
        for await (const c of stream(bread, 'flaky', 'go')) crumbs.push(c)
      })(),
    ).rejects.toThrow('provider hiccup')

    // Text streamed before the error part still reached the consumer …
    const text = crumbs
      .filter((c) => c.type === 'text:delta')
      .map((c) => (c as { delta: string }).delta)
      .join('')
    expect(text).toBe('partial ')

    // … but the run ends in agent:error, never agent:run:end.
    expect(crumbs.map((c) => c.type)).not.toContain('agent:run:end')
    const err = crumbs.find((c) => c.type === 'agent:error') as AgentErrorCrumb | undefined
    expect(err).toBeDefined()
    expect(err!.agentId).toBe('flaky')
  })
})

describe('runner — resumeRun error paths', () => {
  test('resuming an unknown checkpoint throws CHECKPOINT_NOT_FOUND', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('unused'),
    })
    try {
      await expect(collect(bread.resume('nonexistent-checkpoint', {}))).rejects.toThrow(BreadError)
      try {
        await collect(bread.resume('nonexistent-checkpoint', {}))
      } catch (err) {
        expect((err as BreadError).code).toBe('CHECKPOINT_NOT_FOUND')
      }
    } finally {
      await stop()
    }
  })

  test('resuming into an instance that no longer registers the agent throws AGENT_NOT_FOUND', async () => {
    const gateModel = () =>
      mockScript([{ tool: 'human_approve', args: { question: 'ok?' } }, { text: 'approved!' }])
    const testStore = store()
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const first = await makeBread({
      agents: { gate: defineTestAgent({ humanTools: [approve] }) },
      model: gateModel(),
      config: { store: testStore },
    })
    const crumbs = await runCollect(first.bread, 'gate', 'go')
    const required = crumbs.find((c) => c.type === 'human:required') as HumanRequiredCrumb
    await first.stop()

    // A fresh instance over the same store, but the "gate" agent was dropped
    // from the registry (e.g. redeployed without it).
    const second = await makeBread({
      agents: { other: defineTestAgent() },
      model: mockTextModel('unused'),
      config: { store: testStore },
    })
    try {
      await expect(
        collect(second.bread.resume(required.checkpointId, { approved: true })),
      ).rejects.toThrow(BreadError)
      try {
        await collect(second.bread.resume(required.checkpointId, { approved: true }))
      } catch (err) {
        expect((err as BreadError).code).toBe('AGENT_NOT_FOUND')
      }
    } finally {
      await second.stop()
    }
  })

  test('approving a checkpoint whose tool no longer exists on the agent throws TOOL_NOT_FOUND', async () => {
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
    })
    const testStore = store()
    const first = await makeBread({
      agents: {
        calc: defineTestAgent({ tools: [add], config: { permissions: { ask: ['tool:add'] } } }),
      },
      model: mockScript([{ tool: 'tool_add', args: { a: 2, b: 3 } }, { text: 'done' }]),
      config: { store: testStore },
    })
    const crumbs = await runCollect(first.bread, 'calc', 'go')
    const required = crumbs.find((c) => c.type === 'human:required') as HumanRequiredCrumb
    expect(required.kind).toBe('approval')
    await first.stop()

    // A fresh instance over the same store, but "calc" no longer has the
    // "add" tool (e.g. it was removed from the agent's tool list).
    const second = await makeBread({
      agents: { calc: defineTestAgent({ config: { permissions: { ask: ['tool:add'] } } }) },
      model: mockTextModel('unused'),
      config: { store: testStore },
    })
    try {
      // Resume claims (atomically deletes) the checkpoint before checking the
      // tool still exists, so — unlike AGENT_NOT_FOUND above, which is thrown
      // before any claim — this only throws TOOL_NOT_FOUND once; a second
      // attempt would find the checkpoint already gone (CHECKPOINT_NOT_FOUND).
      let error: unknown
      try {
        await collect(second.bread.resume(required.checkpointId, { approved: true }))
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('TOOL_NOT_FOUND')
    } finally {
      await second.stop()
    }
  })
})

describe('runner — continueRun with an already-aborted signal', () => {
  test('a pre-aborted signal ends the run with RUN_CANCELLED before any text streams (mockTextModel)', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hello'),
    })
    try {
      const controller = new AbortController()
      controller.abort()
      const crumbs: BreadCrumb[] = []
      let error: unknown
      try {
        for await (const c of stream(bread, 'a', 'go', { signal: controller.signal })) crumbs.push(c)
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('RUN_CANCELLED')
      expect(crumbs.map((c) => c.type)).not.toContain('text:delta')
      expect(crumbs.map((c) => c.type)).not.toContain('agent:run:end')
      expect(crumbs.map((c) => c.type)).toContain('agent:error')
    } finally {
      await stop()
    }
  })

  test('a pre-aborted signal ends the run with RUN_CANCELLED instead of surfacing the model error (mockErrorModel)', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockErrorModel('should not surface'),
    })
    try {
      const controller = new AbortController()
      controller.abort()
      const crumbs: BreadCrumb[] = []
      let error: unknown
      try {
        for await (const c of stream(bread, 'a', 'go', { signal: controller.signal })) crumbs.push(c)
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('RUN_CANCELLED')
      const err = crumbs.find((c) => c.type === 'agent:error') as AgentErrorCrumb | undefined
      expect(err?.error.code).toBe('RUN_CANCELLED')
    } finally {
      await stop()
    }
  })
})
