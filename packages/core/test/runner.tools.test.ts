import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTool } from '@breadai/core'
import type {
  BreadInstance,
  ToolCallCrumb,
  ToolInputDeltaCrumb,
  ToolInputEndCrumb,
  ToolInputStartCrumb,
  ToolResultCrumb,
  ToolResultPartialCrumb,
} from '@breadai/core'
import { defineTestAgent, makeBread, mockStreamingToolCallModel, mockToolCallModel, runCollect } from '@breadai/test-utils'

describe('runner — tool calls', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>
  let calls: Array<{ a: number; b: number }>

  beforeEach(async () => {
    calls = []
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => {
        calls.push({ a, b })
        return { sum: a + b }
      },
    })
    ;({ bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockToolCallModel({ toolName: 'tool_add', args: { a: 2, b: 3 }, then: 'It is 5' }),
    }))
  })

  afterEach(() => stop())

  test('executes the tool the model requested with the given args', async () => {
    await runCollect(bread, 'calc', 'add 2 and 3')
    expect(calls).toEqual([{ a: 2, b: 3 }])
  })

  test('emits exactly one tool:call and one tool:result crumb carrying the tool result', async () => {
    const crumbs = await runCollect(bread, 'calc', 'go')
    // docs/tools.md's documented contract is singular ("every call emits
    // tool:call and tool:result crumbs") — exact counts guard against the
    // dual-emission bug (buildExecuteTool + the fullStream loop both used to
    // emit these) ever regressing silently.
    expect(crumbs.filter((c) => c.type === 'tool:call')).toHaveLength(1)
    const results = crumbs.filter((c) => c.type === 'tool:result') as ToolResultCrumb[]
    expect(results).toHaveLength(1)
    expect(results[0]?.toolName).toBe('tool_add')
    expect(results[0]?.result).toEqual({ sum: 5 })
    // A plain (non-generator) execute must never emit tool:result:partial.
    expect(crumbs.filter((c) => c.type === 'tool:result:partial')).toHaveLength(0)
  })

  test('streams the model continuation after the tool result', async () => {
    const crumbs = await runCollect(bread, 'calc', 'go')
    const text = crumbs
      .filter((c) => c.type === 'text:delta')
      .map((c) => (c as { delta: string }).delta)
      .join('')
    expect(text).toBe('It is 5')
  })
})

describe('runner — streaming tool-call args', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    })
    const args = JSON.stringify({ a: 2, b: 3 })
    ;({ bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockStreamingToolCallModel({
        toolName: 'tool_add',
        argChunks: [args.slice(0, 5), args.slice(5, 10), args.slice(10)],
        then: 'It is 5',
      }),
    }))
  })

  afterEach(() => stop())

  test('streaming tool-call args emit tool:input:start/delta/end before tool:call, sharing one toolCallId', async () => {
    const crumbs = await runCollect(bread, 'calc', 'go')
    const types = crumbs.map((c) => c.type)

    const startIdx = types.indexOf('tool:input:start')
    const deltaIdxs = types.reduce<number[]>((acc, t, i) => (t === 'tool:input:delta' ? [...acc, i] : acc), [])
    const endIdx = types.indexOf('tool:input:end')

    expect(startIdx).toBeGreaterThan(-1)
    expect(deltaIdxs.length).toBeGreaterThan(0)
    expect(deltaIdxs[0]).toBe(startIdx + 1)
    expect(endIdx).toBeGreaterThan(deltaIdxs[deltaIdxs.length - 1])

    const start = crumbs[startIdx] as ToolInputStartCrumb
    const end = crumbs[endIdx] as ToolInputEndCrumb
    expect(start.toolCallId).toBe(end.toolCallId)
    expect(start.toolName).toBe('tool_add')

    const call = crumbs.find((c) => c.type === 'tool:call') as ToolCallCrumb | undefined
    expect(call).toBeTruthy()
    expect(call?.toolCallId).toBe(start.toolCallId)
    const callIdx = crumbs.indexOf(call!)
    expect(callIdx).toBeGreaterThan(endIdx)

    const streamedArgs = deltaIdxs.map((i) => (crumbs[i] as ToolInputDeltaCrumb).delta).join('')
    expect(JSON.parse(streamedArgs)).toEqual(call?.args)
  })
})

describe('runner — streaming tool progress', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    const track = defineTool({
      name: 'track',
      description: 'Streams progress, then yields a final result',
      schema: z.object({ steps: z.number() }),
      // The final result must itself be yielded, not `return`ed: a plain
      // `for await...of` drain (both bread's and the AI SDK's own) never
      // observes a generator's `return` value, only what it yields.
      async *execute({ steps }: { steps: number }) {
        for (let i = 1; i < steps; i++) {
          yield { step: i, done: false }
        }
        yield { step: steps, done: true }
      },
    })
    ;({ bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [track] }) },
      model: mockToolCallModel({ toolName: 'tool_track', args: { steps: 2 }, then: 'done' }),
    }))
  })

  afterEach(() => stop())

  test('a streaming execute emits tool:result:partial per yield, then exactly one tool:result', async () => {
    const crumbs = await runCollect(bread, 'calc', 'go')
    const partials = crumbs.filter((c) => c.type === 'tool:result:partial') as ToolResultPartialCrumb[]
    const results = crumbs.filter((c) => c.type === 'tool:result') as ToolResultCrumb[]

    expect(partials.map((p) => p.result)).toEqual([
      { step: 1, done: false },
      { step: 2, done: true },
    ])
    expect(results).toHaveLength(1)
    expect(results[0]?.result).toEqual({ step: 2, done: true })

    const lastPartialIdx = crumbs.indexOf(partials[partials.length - 1]!)
    const resultIdx = crumbs.indexOf(results[0]!)
    expect(resultIdx).toBeGreaterThan(lastPartialIdx)
  })
})
