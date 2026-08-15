import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineHumanTool, defineTask, defineTool } from '@bread/core'
import type { PipelineStep } from '@bread/core'
import {
  collect,
  defineTestAgent,
  makeBread,
  memoryBlobStore,
  mockFileGeneratingModel,
  mockObjectModel,
  mockReasoningTextModel,
  mockScript,
  mockTextModel,
  mockToolCallModel,
  runCollect,
} from '@bread/test-utils'
import { type A2UISpec, a2ui } from '@bread/a2ui'

describe('a2ui plugin', () => {
  test('emits declarative UI specs for run progress and text', async () => {
    const specs: A2UISpec[] = []
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('rendered text'),
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const types = specs.map((s) => s.type)
    expect(types).toContain('progress')
    expect(types).toContain('markdown')

    const markdown = specs.find((s) => s.type === 'markdown')
    expect(markdown?.content).toBe('rendered text')
  })

  test('maps reasoning:delta to a text spec, distinct from the markdown spec text:delta gets', async () => {
    const specs: A2UISpec[] = []
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockReasoningTextModel('let me think...', 'the answer'),
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const text = specs.find((s) => s.type === 'text')
    expect(text?.content).toBe('let me think...')

    const markdown = specs.find((s) => s.type === 'markdown')
    expect(markdown?.content).toBe('the answer')
  })

  test('maps pipeline:step:start/end to progress specs via a real runPipeline', async () => {
    const specs: A2UISpec[] = []
    const steps: PipelineStep[] = [{ type: 'agent', agentId: 'a' }]
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
      config: { pipelines: { p: steps } },
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
    })

    for await (const _ of bread.runPipeline('p', 'x')) {
      // drain — the a2ui plugin listens on bread.on('crumb') independently
    }
    await stop()

    const start = specs.find((s) => s.message === 'Pipeline step 0 started')!
    expect(start.type).toBe('progress')
    expect(start.progress).toBe(0)
    expect(start.metadata).toEqual({ pipelineId: 'p', stepIndex: 0 })

    const end = specs.find((s) => s.message === 'Pipeline step 0 done')!
    expect(end.type).toBe('progress')
    expect(end.progress).toBe(1)
    expect(end.metadata).toEqual({ pipelineId: 'p', stepIndex: 0, output: 'hi' })
  })

  test('maps subagent:run:start/end to progress specs via a real mediated supervisor delegation', async () => {
    const specs: A2UISpec[] = []
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
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
    })

    await runCollect(bread, 'parent', 'go')
    await stop()

    const start = specs.find((s) => s.message === 'Sub-agent child started')!
    expect(start.type).toBe('progress')
    expect(start.progress).toBe(0)
    expect(start.metadata).toEqual({ parentAgentId: 'parent', subagentId: 'child' })

    const end = specs.find((s) => s.message === 'Sub-agent child done')!
    expect(end.type).toBe('progress')
    expect(end.progress).toBe(1)
    expect(end.metadata).toEqual({ parentAgentId: 'parent', subagentId: 'child', output: 'sub says hi' })
  })

  test('maps tool:result/tool:error to card/error specs via real tool-calling agents', async () => {
    const specs: A2UISpec[] = []
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    })
    const broken = defineTool({
      name: 'broken',
      description: 'Always fails',
      schema: z.object({}),
      execute: async () => {
        throw new Error('boom')
      },
    })
    const { bread, stop } = await makeBread({
      agents: {
        calc: defineTestAgent({ model: 'calc', tools: [add] }),
        fail: defineTestAgent({ model: 'fail', tools: [broken] }),
      },
      models: {
        calc: mockToolCallModel({ toolName: 'tool_add', args: { a: 1, b: 2 }, then: 'done' }),
        fail: mockToolCallModel({ toolName: 'tool_broken', args: {}, then: 'done' }),
      },
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
    })

    await runCollect(bread, 'calc', 'go')
    await runCollect(bread, 'fail', 'go')
    await stop()

    const result = specs.find((s) => s.type === 'card' && s.metadata?.status === 'done')!
    expect(result.metadata).toEqual({ toolName: 'tool_add', status: 'done', result: { sum: 3 }, durationMs: expect.any(Number) })

    const error = specs.find((s) => s.type === 'error')!
    expect(error.message).toBe('boom')
    expect(error.metadata).toEqual({
      toolName: 'tool_broken',
      toolCallId: expect.any(String),
      durationMs: expect.any(Number),
    })
  })

  test('maps file:generated to a file spec via a real file-generating model', async () => {
    const specs: A2UISpec[] = []
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockFileGeneratingModel('here you go', { mediaType: 'image/png', base64: 'ZmFrZQ==' }),
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
      config: { blobStore: memoryBlobStore() },
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const fileSpec = specs.find((s) => s.type === 'file')!
    expect(fileSpec).toBeDefined()
    expect(fileSpec.metadata?.mimeType).toBe('image/png')
  })

  test('emits a second file spec alongside Done when agent:run:end output is a tool-echoed FileOutput', async () => {
    const specs: A2UISpec[] = []
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { output: { format: { name: 'file-json', parse: (raw: string) => JSON.parse(raw) } } },
        }),
      },
      model: mockTextModel(JSON.stringify({ kind: 'file', uri: 'https://blob.example/report.pdf', mimeType: 'application/pdf' })),
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const types = specs.map((s) => s.type)
    expect(types).toContain('file')
    expect(types).toContain('progress')
    const fileSpec = specs.find((s) => s.type === 'file')!
    expect(fileSpec.metadata?.uri).toBe('https://blob.example/report.pdf')
  })

  test('maps human:resumed to a progress spec via a real HITL resume', async () => {
    const specs: A2UISpec[] = []
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: { gate: defineTestAgent({ humanTools: [approve] }) },
      model: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
    })

    const first = await runCollect(bread, 'gate', 'go')
    const cp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
    await collect(bread.resume(cp.checkpointId, { approved: true }))
    await stop()

    const resumed = specs.find((s) => s.message === 'Human input received')!
    expect(resumed.type).toBe('progress')
    expect(resumed.progress).toBe(1)
    expect(resumed.metadata).toEqual({
      checkpointId: cp.checkpointId,
      kind: 'input',
      response: { approved: true },
    })
  })

  test('maps loop:iteration:end to a progress spec via a real agent-driven loop', async () => {
    const specs: A2UISpec[] = []
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({ model: 'host', config: { loop: { pool: ['worker'], maxIterations: 3 } } }),
        worker: defineTestAgent({ model: 'worker' }),
      },
      models: {
        host: mockScript([
          { tool: 'core_start_loop', args: { pipeline: ['worker'], input: 'seed' } },
          { tool: 'core_finish_loop', args: { result: 'final answer' } },
          { text: 'done' },
        ]),
        worker: mockTextModel('worker output'),
      },
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
    })

    await runCollect(bread, 'host', 'go')
    await stop()

    const end = specs.find((s) => s.message === 'Iteration 1 done')!
    expect(end.type).toBe('progress')
    expect(end.metadata).toEqual({ loopId: expect.any(String), iteration: 1, output: 'worker output' })
  })

  test('maps task:start/task:end to progress specs via a real task-tool run', async () => {
    const specs: A2UISpec[] = []
    const extract = defineTask({
      name: 'extract',
      description: 'Extract entities',
      model: { provider: 'mock', model: 'm' },
      instructions: 'extract entities',
      schema: z.object({ text: z.string() }),
      outputSchema: z.object({ entities: z.array(z.string()) }),
    })
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent({ config: { tasks: ['extract'] } }) },
      models: {
        default: mockToolCallModel({ toolName: 'task_extract', args: { text: 'Ada' }, then: 'done' }),
        m: mockObjectModel({ entities: ['Ada'] }),
      },
      tasks: { extract },
      plugins: [a2ui({ onSpec: (s) => specs.push(s) })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const start = specs.find((s) => s.message === 'Task extract started')!
    expect(start.type).toBe('progress')
    expect(start.progress).toBe(0)
    expect(start.metadata).toEqual({
      taskRunId: expect.any(String),
      taskId: 'extract',
      model: { provider: 'mock', model: 'm' },
    })

    const end = specs.find((s) => s.message === 'Task extract completed')!
    expect(end.type).toBe('progress')
    expect(end.progress).toBe(1)
    expect(end.metadata).toEqual({
      taskRunId: expect.any(String),
      taskId: 'extract',
      status: 'completed',
      durationMs: expect.any(Number),
      usage: expect.any(Object),
      error: undefined,
    })
  })
})
