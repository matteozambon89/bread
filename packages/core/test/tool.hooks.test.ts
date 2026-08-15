import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTool } from '@breadai/core'
import type { HumanRequiredCrumb, ToolErrorCrumb, ToolResultCrumb, ToolResultPartialCrumb } from '@breadai/core'
import {
  collect,
  defineTestAgent,
  makeBread,
  mockToolCallModel,
  runCollect,
} from '@breadai/test-utils'

// The beforeRun/afterRun/onError contract at Tool scope (docs/tools.md#hooks),
// and the tool:error crumb this phase introduced. A live model-driven tool call
// and an approved ask-gated resume both funnel through the same
// executeToolWithHooks, so both are exercised here.

describe('hooks — beforeRun/afterRun (tool scope)', () => {
  test('beforeRun can override the args passed to execute', async () => {
    const seenArgs: unknown[] = []
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      hooks: {
        beforeRun: () => ({ action: 'continue', input: { a: 10, b: 20 } }),
      },
      execute: async (args) => {
        seenArgs.push(args)
        return { sum: args.a + args.b }
      },
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockToolCallModel({ toolName: 'tool_add', args: { a: 1, b: 2 }, then: 'done' }),
    })
    const crumbs = await runCollect(bread, 'calc', 'go')
    expect(seenArgs).toEqual([{ a: 10, b: 20 }])
    const result = crumbs.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
    expect(result?.result).toEqual({ sum: 30 })
    await stop()
  })

  test('a short-circuit skips execute entirely and still runs afterRun', async () => {
    let executed = false
    let afterRunOutput: unknown
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      hooks: {
        beforeRun: () => ({ action: 'shortCircuit', output: { sum: -1 } }),
        afterRun: (ctx) => {
          afterRunOutput = ctx.output
        },
      },
      execute: async (args) => {
        executed = true
        return { sum: args.a + args.b }
      },
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockToolCallModel({ toolName: 'tool_add', args: { a: 1, b: 2 }, then: 'done' }),
    })
    const crumbs = await runCollect(bread, 'calc', 'go')
    // The real execute is never invoked — the AI SDK still reports its own
    // tool-call/tool-result stream parts (it doesn't know execute was
    // bypassed), but the *result* it sees is the short-circuited value.
    expect(executed).toBe(false)
    const result = crumbs.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
    expect(result?.result).toEqual({ sum: -1 })
    expect(afterRunOutput).toEqual({ sum: -1 })
    await stop()
  })

  // Coverage gap closed post-runner-split (runner-tool-execution.ts): a
  // beforeRun short-circuit on a *streaming* (async-generator execute) tool —
  // executeStreamingToolWithHooks's own short-circuit branch, distinct from
  // executeToolWithHooks's (the non-streaming test above).
  test('a short-circuit on a streaming tool skips execute, yields no partials, and still runs afterRun', async () => {
    let executed = false
    let afterRunOutput: unknown
    const track = defineTool({
      name: 'track',
      description: 'Streams progress',
      schema: z.object({ steps: z.number() }),
      hooks: {
        beforeRun: () => ({ action: 'shortCircuit', output: { step: -1, done: true } }),
        afterRun: (ctx) => {
          afterRunOutput = ctx.output
        },
      },
      async *execute({ steps }: { steps: number }) {
        executed = true
        for (let i = 1; i <= steps; i++) yield { step: i, done: i === steps }
      },
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [track] }) },
      model: mockToolCallModel({ toolName: 'tool_track', args: { steps: 2 }, then: 'done' }),
    })
    const crumbs = await runCollect(bread, 'calc', 'go')
    expect(executed).toBe(false)
    expect(crumbs.filter((c) => c.type === 'tool:result:partial')).toHaveLength(0)
    const result = crumbs.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
    expect(result?.result).toEqual({ step: -1, done: true })
    expect(afterRunOutput).toEqual({ step: -1, done: true })
    await stop()
  })

  test('afterRun can replace the tool result', async () => {
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      hooks: { afterRun: () => ({ output: { sum: 999 } }) },
      execute: async (args) => ({ sum: args.a + args.b }),
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockToolCallModel({ toolName: 'tool_add', args: { a: 1, b: 2 }, then: 'done' }),
    })
    const crumbs = await runCollect(bread, 'calc', 'go')
    const result = crumbs.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
    // The crumb shows the raw result — afterRun's replacement feeds the model instead.
    expect(result?.result).toEqual({ sum: 3 })
    await stop()
  })
})

describe('hooks — onError + tool:error crumb (tool scope)', () => {
  test('a thrown execute with no hooks emits tool:error (the previously silently-dropped case)', async () => {
    const broken = defineTool({
      name: 'broken',
      description: 'Always fails',
      schema: z.object({}),
      execute: async () => {
        throw new Error('boom')
      },
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [broken] }) },
      model: mockToolCallModel({ toolName: 'tool_broken', args: {}, then: 'done' }),
    })
    const crumbs = await runCollect(bread, 'calc', 'go')
    const errorCrumb = crumbs.find((c) => c.type === 'tool:error') as ToolErrorCrumb | undefined
    expect(errorCrumb).toBeDefined()
    expect(errorCrumb?.toolName).toBe('tool_broken')
    expect(errorCrumb?.error.code).toBe('TOOL_ERROR')
    expect(crumbs.map((c) => c.type)).not.toContain('tool:result')
    await stop()
  })

  // Coverage gap closed post-runner-split (runner-tool-execution.ts): a
  // streaming (async-generator execute) tool that throws mid-drain —
  // executeStreamingToolWithHooks's own catch block, distinct from
  // executeToolWithHooks's (the non-streaming test above).
  test('a streaming execute that throws mid-drain emits tool:error with the partials already yielded', async () => {
    const track = defineTool({
      name: 'track',
      description: 'Streams progress then fails',
      schema: z.object({}),
      async *execute() {
        yield { step: 1 }
        throw new Error('boom mid-stream')
      },
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [track] }) },
      model: mockToolCallModel({ toolName: 'tool_track', args: {}, then: 'done' }),
    })
    const crumbs = await runCollect(bread, 'calc', 'go')
    const partials = crumbs.filter((c) => c.type === 'tool:result:partial') as ToolResultPartialCrumb[]
    expect(partials.map((p) => p.result)).toEqual([{ step: 1 }])
    const errorCrumb = crumbs.find((c) => c.type === 'tool:error') as ToolErrorCrumb | undefined
    expect(errorCrumb?.toolName).toBe('tool_track')
    expect(errorCrumb?.error.code).toBe('TOOL_ERROR')
    expect(crumbs.map((c) => c.type)).not.toContain('tool:result')
    await stop()
  })

  test('onError recover substitutes a result and no tool:error crumb is emitted', async () => {
    const broken = defineTool({
      name: 'broken',
      description: 'Always fails',
      schema: z.object({}),
      hooks: { onError: () => ({ action: 'recover', output: { fallback: true } }) },
      execute: async () => {
        throw new Error('boom')
      },
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [broken] }) },
      model: mockToolCallModel({ toolName: 'tool_broken', args: {}, then: 'done' }),
    })
    const crumbs = await runCollect(bread, 'calc', 'go')
    expect(crumbs.map((c) => c.type)).not.toContain('tool:error')
    const result = crumbs.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
    expect(result?.result).toEqual({ fallback: true })
    await stop()
  })

  test('a hook returning retry, backed by errorHandling.retry, re-invokes until it succeeds', async () => {
    let calls = 0
    const flaky = defineTool({
      name: 'flaky',
      description: 'Fails twice then succeeds',
      schema: z.object({}),
      errorHandling: { retry: { attempts: 5, backoffMs: 1 } },
      execute: async () => {
        calls++
        if (calls <= 2) throw new Error(`flaky ${calls}`)
        return { ok: true }
      },
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [flaky] }) },
      model: mockToolCallModel({ toolName: 'tool_flaky', args: {}, then: 'done' }),
    })
    const crumbs = await runCollect(bread, 'calc', 'go')
    expect(calls).toBe(3)
    const result = crumbs.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
    expect(result?.result).toEqual({ ok: true })
    expect(crumbs.map((c) => c.type)).not.toContain('tool:error')
    await stop()
  })
})

describe('hooks — resume-path parity (tool scope)', () => {
  test('an approved ask-gated tool call goes through the same beforeRun/afterRun chain', async () => {
    const seenArgs: unknown[] = []
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      hooks: {
        beforeRun: () => ({ action: 'continue', input: { a: 100, b: 200 } }),
        afterRun: () => ({ output: { sum: 999 } }),
      },
      execute: async (args) => {
        seenArgs.push(args)
        return { sum: args.a + args.b }
      },
    })
    const { bread, stop } = await makeBread({
      agents: {
        calc: defineTestAgent({ tools: [add], config: { permissions: { ask: ['tool:add'] } } }),
      },
      model: mockToolCallModel({ toolName: 'tool_add', args: { a: 1, b: 2 }, then: 'the sum' }),
    })
    const first = await runCollect(bread, 'calc', 'go')
    const required = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb

    const cont = await collect(bread.resume(required.checkpointId, { approved: true }))
    expect(seenArgs).toEqual([{ a: 100, b: 200 }])
    const result = cont.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
    expect(result?.result).toEqual({ sum: 300 })
    await stop()
  })

  // Coverage gap closed post-runner-split (runner-resume.ts): an approved
  // ask-gated tool whose execute is itself a streaming (async-generator)
  // function — resumeRun must drain it (not await the raw AsyncGenerator
  // object), and yield the partial/result crumbs the drain produces.
  test('an approved ask-gated streaming tool is drained, not awaited-as-a-promise', async () => {
    const track = defineTool({
      name: 'track',
      description: 'Streams progress',
      schema: z.object({ steps: z.number() }),
      async *execute({ steps }: { steps: number }) {
        for (let i = 1; i <= steps; i++) yield { step: i, done: i === steps }
      },
    })
    const { bread, stop } = await makeBread({
      agents: {
        calc: defineTestAgent({ tools: [track], config: { permissions: { ask: ['tool:track'] } } }),
      },
      model: mockToolCallModel({ toolName: 'tool_track', args: { steps: 2 }, then: 'done' }),
    })
    const first = await runCollect(bread, 'calc', 'go')
    const required = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
    expect(required.kind).toBe('approval')

    const cont = await collect(bread.resume(required.checkpointId, { approved: true }))
    const partials = cont.filter((c) => c.type === 'tool:result:partial') as ToolResultPartialCrumb[]
    const results = cont.filter((c) => c.type === 'tool:result') as ToolResultCrumb[]
    expect(partials.map((p) => p.result)).toEqual([
      { step: 1, done: false },
      { step: 2, done: true },
    ])
    expect(results).toHaveLength(1)
    expect(results[0]?.result).toEqual({ step: 2, done: true })
    await stop()
  })

  test('an unresolved onError on the resume path rejects the resume() call', async () => {
    const broken = defineTool({
      name: 'broken',
      description: 'Always fails',
      schema: z.object({}),
      execute: async () => {
        throw new Error('boom on resume')
      },
    })
    const { bread, stop } = await makeBread({
      agents: {
        calc: defineTestAgent({ tools: [broken], config: { permissions: { ask: ['tool:broken'] } } }),
      },
      model: mockToolCallModel({ toolName: 'tool_broken', args: {}, then: 'done' }),
    })
    const first = await runCollect(bread, 'calc', 'go')
    const required = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb

    await expect(collect(bread.resume(required.checkpointId, { approved: true }))).rejects.toThrow(
      /boom on resume/,
    )
    await stop()
  })
})
