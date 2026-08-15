import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { BreadError, defineTask, defineTool } from '@bread/core'
import type { BreadCrumb } from '@bread/core'
import {
  defineTestAgent,
  makeBread,
  memoryBlobStore,
  mockFileGeneratingModel,
  mockFlakyObjectModel,
  mockObjectModel,
  mockScript,
  mockStreamingToolCallModel,
  mockTextModel,
  mockToolCallModel,
  runCollect,
} from '@bread/test-utils'
import { type AgUiEvent, agUi, createAgUiTransformer } from '@bread/protocol-ag-ui'

describe('agUi plugin — live run', () => {
  test('frames text with TEXT_MESSAGE_START/END and maps the full tool lifecycle', async () => {
    const events: AgUiEvent[] = []
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockToolCallModel({ toolName: 'tool_add', args: { a: 2, b: 3 }, then: 'It is 5' }),
      plugins: [agUi({ onEvent: (e) => events.push(e) })],
    })

    await runCollect(bread, 'calc', 'go')
    await stop()

    const types = events.map((e) => e.type)
    // Tool lifecycle: START → ARGS → END, then the RESULT after execution.
    expect(types).toEqual(
      expect.arrayContaining(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT']),
    )
    expect(types.indexOf('TOOL_CALL_ARGS')).toBe(types.indexOf('TOOL_CALL_START') + 1)
    expect(types.indexOf('TOOL_CALL_END')).toBe(types.indexOf('TOOL_CALL_ARGS') + 1)
    expect(types.indexOf('TOOL_CALL_RESULT')).toBeGreaterThan(types.indexOf('TOOL_CALL_END'))

    // Text framing: the final answer's deltas sit between START and END.
    const start = types.indexOf('TEXT_MESSAGE_START')
    const content = types.indexOf('TEXT_MESSAGE_CONTENT')
    const end = types.indexOf('TEXT_MESSAGE_END')
    expect(start).toBeGreaterThan(-1)
    expect(content).toBe(start + 1)
    expect(end).toBeGreaterThan(content)

    // START/CONTENT/END share one messageId; spec field names throughout.
    const startEvt = events[start] as Extract<AgUiEvent, { type: 'TEXT_MESSAGE_START' }>
    const contentEvt = events[content] as Extract<AgUiEvent, { type: 'TEXT_MESSAGE_CONTENT' }>
    const endEvt = events[end] as Extract<AgUiEvent, { type: 'TEXT_MESSAGE_END' }>
    expect(startEvt.role).toBe('assistant')
    expect(contentEvt.messageId).toBe(startEvt.messageId)
    expect(endEvt.messageId).toBe(startEvt.messageId)
    expect(contentEvt.delta).toBe('It is 5')

    // Run lifecycle carries threadId (bread sessionId) and the final result.
    const started = events.find((e) => e.type === 'RUN_STARTED') as Extract<AgUiEvent, { type: 'RUN_STARTED' }>
    const finished = events.find((e) => e.type === 'RUN_FINISHED') as Extract<
      AgUiEvent,
      { type: 'RUN_FINISHED' }
    >
    expect(started.threadId).toBeTruthy()
    expect(finished.threadId).toBe(started.threadId)
    expect(finished.result).toBe('It is 5')
    // The message must be closed before the run finishes.
    expect(end).toBeLessThan(types.indexOf('RUN_FINISHED'))
  })

  test('a plain text run opens and closes exactly one message', async () => {
    const events: AgUiEvent[] = []
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hello'),
      plugins: [agUi({ onEvent: (e) => events.push(e) })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const types = events.map((e) => e.type)
    expect(types).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED'])
  })

  test('a real mediated supervisor delegation maps subagent:run:start/end to step + snapshot events', async () => {
    const events: AgUiEvent[] = []
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
      plugins: [agUi({ onEvent: (e) => events.push(e) })],
    })

    await runCollect(bread, 'parent', 'go')
    await stop()

    const started = events.find(
      (e) => e.type === 'STEP_STARTED' && e.stepName === 'subagent_child',
    ) as Extract<AgUiEvent, { type: 'STEP_STARTED' }>
    expect(started).toBeTruthy()

    const finished = events.find(
      (e) => e.type === 'STEP_FINISHED' && e.stepName === 'subagent_child',
    ) as Extract<AgUiEvent, { type: 'STEP_FINISHED' }>
    expect(finished).toBeTruthy()

    const snapshots = events.filter((e) => e.type === 'STATE_SNAPSHOT') as Extract<
      AgUiEvent,
      { type: 'STATE_SNAPSHOT' }
    >[]
    const endSnapshot = snapshots.find(
      (s) => (s.snapshot as { subagent?: { status?: string } }).subagent?.status === 'finished',
    )
    expect(endSnapshot?.snapshot).toEqual({
      subagent: { parentAgentId: 'parent', subagentId: 'child', status: 'finished', output: 'sub says hi' },
    })
  })

  test('a real streaming tool call maps tool:input:* to real per-chunk TOOL_CALL_ARGS deltas', async () => {
    const events: AgUiEvent[] = []
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    })
    const args = JSON.stringify({ a: 2, b: 3 })
    const argChunks = [args.slice(0, 5), args.slice(5, 10), args.slice(10)]
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockStreamingToolCallModel({ toolName: 'tool_add', argChunks, then: 'It is 5' }),
      plugins: [agUi({ onEvent: (e) => events.push(e) })],
    })

    await runCollect(bread, 'calc', 'go')
    await stop()

    const types = events.map((e) => e.type)
    const argsEvents = events.filter((e) => e.type === 'TOOL_CALL_ARGS') as Extract<
      AgUiEvent,
      { type: 'TOOL_CALL_ARGS' }
    >[]
    // Real per-chunk deltas, not one full-JSON blob — and no duplicate
    // START/ARGS/END from the later tool:call crumb.
    expect(argsEvents.map((e) => e.delta)).toEqual(argChunks)
    expect(argsEvents.map((e) => e.delta).join('')).toBe(args)
    expect(types.filter((t) => t === 'TOOL_CALL_START')).toHaveLength(1)
    expect(types.filter((t) => t === 'TOOL_CALL_END')).toHaveLength(1)

    const start = types.indexOf('TOOL_CALL_START')
    const firstArgs = types.indexOf('TOOL_CALL_ARGS')
    const end = types.indexOf('TOOL_CALL_END')
    const result = types.indexOf('TOOL_CALL_RESULT')
    expect(firstArgs).toBe(start + 1)
    expect(end).toBe(start + 1 + argChunks.length)
    expect(result).toBeGreaterThan(end)

    const startEvt = events[start] as Extract<AgUiEvent, { type: 'TOOL_CALL_START' }>
    const endEvt = events[end] as Extract<AgUiEvent, { type: 'TOOL_CALL_END' }>
    expect(argsEvents.every((e) => e.toolCallId === startEvt.toolCallId)).toBe(true)
    expect(endEvt.toolCallId).toBe(startEvt.toolCallId)
  })

  test('a real task-tool run maps task:start/task:end to step + snapshot events', async () => {
    const events: AgUiEvent[] = []
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
      plugins: [agUi({ onEvent: (e) => events.push(e) })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const started = events.filter((e) => e.type === 'STEP_STARTED') as Extract<
      AgUiEvent,
      { type: 'STEP_STARTED' }
    >[]
    const taskStep = started.find((e) => e.stepName.startsWith('task_'))
    expect(taskStep).toBeTruthy()
    const taskRunId = taskStep!.stepName.slice('task_'.length)

    const finished = events.find(
      (e) => e.type === 'STEP_FINISHED' && e.stepName === `task_${taskRunId}`,
    )
    expect(finished).toBeTruthy()

    const snapshots = events.filter((e) => e.type === 'STATE_SNAPSHOT') as Extract<
      AgUiEvent,
      { type: 'STATE_SNAPSHOT' }
    >[]
    const startSnapshot = snapshots.find(
      (s) => (s.snapshot as { task?: { status?: string } }).task?.status === 'running',
    )
    expect(startSnapshot?.snapshot).toEqual({
      task: { taskRunId, taskId: 'extract', model: { provider: 'mock', model: 'm' }, status: 'running' },
    })

    const endSnapshot = snapshots.find(
      (s) => (s.snapshot as { task?: { status?: string } }).task?.status === 'completed',
    )
    expect(endSnapshot?.snapshot).toEqual({
      task: {
        taskRunId,
        taskId: 'extract',
        status: 'completed',
        durationMs: expect.any(Number),
        usage: expect.any(Object),
        error: undefined,
      },
    })
  })

  test('a failing task-tool run maps task:end to a failed-status snapshot', async () => {
    const events: AgUiEvent[] = []
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
        // generateObject drives doGenerate, not doStream — mockFlakyObjectModel
        // is the helper that mocks doGenerate to throw (mockErrorModel only
        // covers the doStream path, used elsewhere for the host agent's model).
        m: mockFlakyObjectModel(1, { entities: [] }),
      },
      tasks: { extract },
      plugins: [agUi({ onEvent: (e) => events.push(e) })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const snapshots = events.filter((e) => e.type === 'STATE_SNAPSHOT') as Extract<
      AgUiEvent,
      { type: 'STATE_SNAPSHOT' }
    >[]
    const endSnapshot = snapshots.find(
      (s) => (s.snapshot as { task?: { status?: string } }).task?.status === 'failed',
    )
    expect(endSnapshot?.snapshot).toMatchObject({
      task: { taskId: 'extract', status: 'failed', error: expect.stringContaining('flaky failure 1') },
    })
  })

  test('maps file:generated to a CUSTOM FILE_GENERATED event via a real file-generating model', async () => {
    const events: AgUiEvent[] = []
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockFileGeneratingModel('here you go', { mediaType: 'image/png', base64: 'ZmFrZQ==' }),
      plugins: [agUi({ onEvent: (e) => events.push(e) })],
      config: { blobStore: memoryBlobStore() },
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const custom = events.find((e) => e.type === 'CUSTOM') as Extract<AgUiEvent, { type: 'CUSTOM' }>
    expect(custom).toBeDefined()
    expect(custom.name).toBe('FILE_GENERATED')
    expect((custom.value as { mimeType: string }).mimeType).toBe('image/png')
  })

  test('emits a CUSTOM FILE_GENERATED event before RUN_FINISHED when output is a tool-echoed FileOutput', async () => {
    const events: AgUiEvent[] = []
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { output: { format: { name: 'file-json', parse: (raw: string) => JSON.parse(raw) } } },
        }),
      },
      model: mockTextModel(JSON.stringify({ kind: 'file', uri: 'https://blob.example/report.pdf', mimeType: 'application/pdf' })),
      plugins: [agUi({ onEvent: (e) => events.push(e) })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const types = events.map((e) => e.type)
    const custom = types.indexOf('CUSTOM')
    const finished = types.indexOf('RUN_FINISHED')
    expect(custom).toBeGreaterThan(-1)
    expect(custom).toBeLessThan(finished)
  })
})

describe('agUi transformer — synthetic crumbs', () => {
  const base = { agentId: 'a', runId: 'r1', sessionId: 's1', timestamp: 1 }

  test('agent:error closes an open message and maps to RUN_ERROR with the code', () => {
    const transform = createAgUiTransformer()
    transform({ type: 'agent:run:start', ...base, input: 'x' } as BreadCrumb)
    transform({ type: 'text:delta', ...base, delta: 'partial' } as BreadCrumb)

    const out = transform({
      type: 'agent:error',
      ...base,
      error: new BreadError('boom', 'UNKNOWN_PROVIDER'),
    } as BreadCrumb)

    expect(out.map((e) => e.type)).toEqual(['TEXT_MESSAGE_END', 'RUN_ERROR'])
    const err = out[1] as Extract<AgUiEvent, { type: 'RUN_ERROR' }>
    expect(err.message).toBe('boom')
    expect(err.code).toBe('UNKNOWN_PROVIDER')
  })

  test('tool:result maps to TOOL_CALL_RESULT with the raw result serialized', () => {
    const transform = createAgUiTransformer()
    const out = transform({
      type: 'tool:result',
      ...base,
      toolCallId: 'c1',
      toolName: 'add',
      result: { sum: 5 },
      durationMs: 3,
    } as BreadCrumb)
    expect(out).toHaveLength(1)
    const result = out[0] as Extract<AgUiEvent, { type: 'TOOL_CALL_RESULT' }>
    expect(result.type).toBe('TOOL_CALL_RESULT')
    expect(result.toolCallId).toBe('c1')
    expect(result.content).toBe(JSON.stringify({ sum: 5 }))
  })

  test('tool:result with a string result is not re-JSON-stringified', () => {
    const transform = createAgUiTransformer()
    const out = transform({
      type: 'tool:result',
      ...base,
      toolCallId: 'c1',
      toolName: 'echo',
      result: 'plain text',
      durationMs: 1,
    } as BreadCrumb)
    const result = out[0] as Extract<AgUiEvent, { type: 'TOOL_CALL_RESULT' }>
    expect(result.content).toBe('plain text')
  })

  test('tool:error maps to TOOL_CALL_RESULT carrying the error code/message', () => {
    const transform = createAgUiTransformer()
    const out = transform({
      type: 'tool:error',
      ...base,
      toolCallId: 'c1',
      toolName: 'add',
      error: new BreadError('boom', 'TOOL_FAILED'),
      durationMs: 2,
    } as BreadCrumb)
    expect(out).toHaveLength(1)
    const result = out[0] as Extract<AgUiEvent, { type: 'TOOL_CALL_RESULT' }>
    expect(result.type).toBe('TOOL_CALL_RESULT')
    expect(result.toolCallId).toBe('c1')
    expect(JSON.parse(result.content)).toEqual({ error: { code: 'TOOL_FAILED', message: 'boom' } })
  })

  test('pipeline:step:start/end map to STEP_STARTED/STEP_FINISHED with the same stepName', () => {
    const transform = createAgUiTransformer()
    const started = transform({
      type: 'pipeline:step:start',
      pipelineId: 'p1',
      stepIndex: 0,
      agentId: 'a',
      runId: 'r1',
      timestamp: 1,
    } as unknown as BreadCrumb)
    const ended = transform({
      type: 'pipeline:step:end',
      pipelineId: 'p1',
      stepIndex: 0,
      agentId: 'a',
      runId: 'r1',
      output: 'done',
      timestamp: 2,
    } as unknown as BreadCrumb)

    expect(started).toEqual([{ type: 'STEP_STARTED', timestamp: 1, stepName: 'step_0_a' }])
    expect(ended).toEqual([{ type: 'STEP_FINISHED', timestamp: 2, stepName: 'step_0_a' }])
  })

  test('subagent:run:start/end map to STEP_STARTED/FINISHED plus a status/output snapshot', () => {
    const transform = createAgUiTransformer()
    const started = transform({
      type: 'subagent:run:start',
      ...base,
      parentAgentId: 'parent',
      subagentId: 'child',
    } as unknown as BreadCrumb)
    const ended = transform({
      type: 'subagent:run:end',
      ...base,
      parentAgentId: 'parent',
      subagentId: 'child',
      output: 'sub says hi',
    } as unknown as BreadCrumb)

    expect(started.map((e) => e.type)).toEqual(['STEP_STARTED', 'STATE_SNAPSHOT'])
    expect((started[0] as Extract<AgUiEvent, { type: 'STEP_STARTED' }>).stepName).toBe('subagent_child')
    const snapStart = (started[1] as Extract<AgUiEvent, { type: 'STATE_SNAPSHOT' }>).snapshot as {
      subagent: Record<string, unknown>
    }
    expect(snapStart.subagent).toEqual({ parentAgentId: 'parent', subagentId: 'child', status: 'running' })

    expect(ended.map((e) => e.type)).toEqual(['STEP_FINISHED', 'STATE_SNAPSHOT'])
    expect((ended[0] as Extract<AgUiEvent, { type: 'STEP_FINISHED' }>).stepName).toBe('subagent_child')
    const snapEnd = (ended[1] as Extract<AgUiEvent, { type: 'STATE_SNAPSHOT' }>).snapshot as {
      subagent: Record<string, unknown>
    }
    expect(snapEnd.subagent).toEqual({
      parentAgentId: 'parent',
      subagentId: 'child',
      status: 'finished',
      output: 'sub says hi',
    })
  })

  test('loop:iteration:end maps to STEP_FINISHED plus an iterated-phase snapshot', () => {
    const transform = createAgUiTransformer()
    transform({
      type: 'loop:start',
      ...base,
      loopId: 'l1',
      pipeline: [],
      maxIterations: 3,
    } as unknown as BreadCrumb)

    const out = transform({
      type: 'loop:iteration:end',
      ...base,
      loopId: 'l1',
      iteration: 1,
      output: 'iteration result',
    } as unknown as BreadCrumb)

    expect(out.map((e) => e.type)).toEqual(['STEP_FINISHED', 'STATE_SNAPSHOT'])
    expect((out[0] as Extract<AgUiEvent, { type: 'STEP_FINISHED' }>).stepName).toBe('loop_iteration_1')
    const snap = (out[1] as Extract<AgUiEvent, { type: 'STATE_SNAPSHOT' }>).snapshot as {
      loop: Record<string, unknown>
    }
    // State accretes: maxIterations from loop:start survives onto this snapshot.
    expect(snap.loop).toMatchObject({ loopId: 'l1', phase: 'iterated', iteration: 1, maxIterations: 3 })
  })

  test('human:required closes the open message so clients are not left streaming', () => {
    const transform = createAgUiTransformer()
    transform({ type: 'text:delta', ...base, delta: 'thinking…' } as BreadCrumb)
    const out = transform({
      type: 'human:required',
      ...base,
      checkpointId: 'cp1',
      toolName: 'human_approve',
      schema: {},
      kind: 'input',
    } as BreadCrumb)
    expect(out.map((e) => e.type)).toEqual(['TEXT_MESSAGE_END'])
  })

  test('loop crumbs emit one consistent snapshot shape plus iteration steps', () => {
    const transform = createAgUiTransformer()
    const started = transform({
      type: 'loop:start',
      ...base,
      loopId: 'l1',
      pipeline: [],
      maxIterations: 3,
    } as unknown as BreadCrumb)
    const iterating = transform({
      type: 'loop:iteration:start',
      ...base,
      loopId: 'l1',
      iteration: 1,
    } as unknown as BreadCrumb)
    const ended = transform({
      type: 'loop:end',
      ...base,
      loopId: 'l1',
      status: 'completed',
      iterations: 1,
      result: 'done',
    } as unknown as BreadCrumb)

    const snap0 = (started[0] as Extract<AgUiEvent, { type: 'STATE_SNAPSHOT' }>).snapshot as {
      loop: Record<string, unknown>
    }
    expect(snap0.loop).toMatchObject({ loopId: 'l1', phase: 'running', maxIterations: 3 })

    expect(iterating.map((e) => e.type)).toEqual(['STEP_STARTED', 'STATE_SNAPSHOT'])

    const snapEnd = (ended[0] as Extract<AgUiEvent, { type: 'STATE_SNAPSHOT' }>).snapshot as {
      loop: Record<string, unknown>
    }
    // State accretes across snapshots: maxIterations from loop:start survives.
    expect(snapEnd.loop).toMatchObject({ loopId: 'l1', phase: 'finished', status: 'completed', maxIterations: 3 })
  })
})
