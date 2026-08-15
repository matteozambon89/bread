import { describe, expect, test } from 'bun:test'
import type { Tracer } from '@opentelemetry/api'
import { defineHumanTool, defineTool } from '@bread/core'
import type { PipelineStep } from '@bread/core'
import {
  collect,
  defineTestAgent,
  makeBread,
  memoryBlobStore,
  mockErrorModel,
  mockFileGeneratingModel,
  mockScript,
  mockTextModel,
  mockToolCallModel,
  runCollect,
} from '@bread/test-utils'
import type { ScriptStep } from '@bread/test-utils'
import { otel } from '@bread/otel'
import { z } from 'zod'

interface FakeSpan {
  name: string
  attributes: Record<string, unknown>
  ended: boolean
  exceptions: unknown[]
}

// A minimal in-memory tracer — otel() uses startSpan/setAttribute/recordException/end.
function fakeTracer(): { tracer: Tracer; spans: FakeSpan[] } {
  const spans: FakeSpan[] = []
  const tracer = {
    startSpan(name: string, opts?: { attributes?: Record<string, unknown> }) {
      const span: FakeSpan = { name, attributes: { ...opts?.attributes }, ended: false, exceptions: [] }
      spans.push(span)
      return {
        setAttribute(k: string, v: unknown) {
          span.attributes[k] = v
        },
        recordException(err: unknown) {
          span.exceptions.push(err)
        },
        end() {
          span.ended = true
        },
        // Real spans carry spanContext(); the plugin passes spans into
        // trace.setSpan for parent linking, which requires it.
        spanContext() {
          return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 }
        },
      }
    },
  } as unknown as Tracer
  return { tracer, spans }
}

describe('otel plugin', () => {
  test('opens and closes an agent.run span for a run', async () => {
    const { tracer, spans } = fakeTracer()
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [otel({ tracer })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const runSpan = spans.find((s) => s.name === 'agent.run')
    expect(runSpan).toBeDefined()
    expect(runSpan!.ended).toBe(true)
    expect(runSpan!.attributes['bread.agent_id']).toBe('a')
  })

  test('opens and closes a tool.call span per tool call', async () => {
    const { tracer, spans } = fakeTracer()
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockToolCallModel({ toolName: 'tool_add', args: { a: 1, b: 2 }, then: 'done' }),
      plugins: [otel({ tracer })],
    })

    await runCollect(bread, 'calc', 'go')
    await stop()

    const toolSpan = spans.find((s) => s.name === 'tool.call.tool_add')
    expect(toolSpan).toBeDefined()
    expect(toolSpan!.ended).toBe(true)
    expect(toolSpan!.attributes['bread.tool_name']).toBe('tool_add')
    expect(toolSpan!.attributes['bread.duration_ms']).toBeDefined()
  })

  test('opens and closes a file.generated span for a model-generated file', async () => {
    const { tracer, spans } = fakeTracer()
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockFileGeneratingModel('here you go', { mediaType: 'image/png', base64: 'ZmFrZQ==' }),
      plugins: [otel({ tracer })],
      config: { blobStore: memoryBlobStore() },
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const fileSpan = spans.find((s) => s.name === 'file.generated')
    expect(fileSpan).toBeDefined()
    expect(fileSpan!.ended).toBe(true)
    expect(fileSpan!.attributes['bread.file_mime_type']).toBe('image/png')
  })

  test('tags the agent.run span when the run output is a tool-echoed FileOutput', async () => {
    const { tracer, spans } = fakeTracer()
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { output: { format: { name: 'file-json', parse: (raw: string) => JSON.parse(raw) } } },
        }),
      },
      model: mockTextModel(JSON.stringify({ kind: 'file', uri: 'https://blob.example/report.pdf', mimeType: 'application/pdf' })),
      plugins: [otel({ tracer })],
    })

    await runCollect(bread, 'a', 'go')
    await stop()

    const runSpan = spans.find((s) => s.name === 'agent.run')
    expect(runSpan!.attributes['bread.output_file_uri']).toBe('https://blob.example/report.pdf')
  })

  test('opens and closes a pipeline.step span per pipeline step', async () => {
    const { tracer, spans } = fakeTracer()
    const steps: PipelineStep[] = [{ type: 'agent', agentId: 'a' }]
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [otel({ tracer })],
      config: { pipelines: { p: steps } },
    })

    for await (const _ of bread.runPipeline('p', 'x')) {
      // drain
    }
    await stop()

    const stepSpan = spans.find((s) => s.name === 'pipeline.step.0')
    expect(stepSpan).toBeDefined()
    expect(stepSpan!.ended).toBe(true)
    expect(stepSpan!.attributes['bread.pipeline_id']).toBe('p')
  })

  test('opens a human.wait span on suspend and closes it on resume', async () => {
    const { tracer, spans } = fakeTracer()
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: { gate: defineTestAgent({ humanTools: [approve] }) },
      model: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
      plugins: [otel({ tracer })],
    })

    const first = await runCollect(bread, 'gate', 'go')
    const cp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
    const waitSpan = spans.find((s) => s.name === 'human.wait')
    expect(waitSpan).toBeDefined()
    expect(waitSpan!.ended).toBe(false)
    expect(waitSpan!.attributes['bread.tool_name']).toBe('human_approve')

    await collect(bread.resume(cp.checkpointId, { approved: true }))
    await stop()

    expect(waitSpan!.ended).toBe(true)
  })

  test('opens and closes a subagent.run span for a mediated sub-agent run', async () => {
    const { tracer, spans } = fakeTracer()
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'w1', visibility: 'mediate' }] } },
        }),
        w1: defineTestAgent({ model: 'w1' }),
      },
      models: {
        boss: mockScript([{ tool: 'core_delegate', args: { agentId: 'w1', input: 'go' } }, { text: 'done' }]),
        w1: mockTextModel('one'),
      },
      plugins: [otel({ tracer })],
    })

    await runCollect(bread, 'boss', 'go')
    await stop()

    const subagentSpan = spans.find((s) => s.name === 'subagent.run')
    expect(subagentSpan).toBeDefined()
    expect(subagentSpan!.ended).toBe(true)
    expect(subagentSpan!.attributes['bread.agent_id']).toBe('w1')
    expect(subagentSpan!.attributes['bread.parent_agent_id']).toBe('boss')
  })

  test('opens and closes loop.run and loop.iteration spans for a completed loop', async () => {
    const { tracer, spans } = fakeTracer()
    const start: ScriptStep = { tool: 'core_start_loop', args: { pipeline: ['worker'], input: 'seed' } }
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({ model: 'host', config: { loop: { pool: ['worker'], maxIterations: 3 } } }),
        worker: defineTestAgent({ model: 'worker' }),
      },
      models: {
        host: mockScript([start, { tool: 'core_finish_loop', args: { result: 'final answer' } }, { text: 'done' }]),
        worker: mockTextModel('worker output'),
      },
      plugins: [otel({ tracer })],
    })

    await runCollect(bread, 'host', 'go')
    await stop()

    const loopSpan = spans.find((s) => s.name === 'loop.run')
    expect(loopSpan).toBeDefined()
    expect(loopSpan!.ended).toBe(true)
    expect(loopSpan!.attributes['bread.status']).toBe('completed')

    const iterSpan = spans.find((s) => s.name === 'loop.iteration.1')
    expect(iterSpan).toBeDefined()
    expect(iterSpan!.ended).toBe(true)
  })

  test('closes a dangling loop.iteration span when loop:end fires with no matching iteration:end', async () => {
    const { tracer, spans } = fakeTracer()
    const start: ScriptStep = { tool: 'core_start_loop', args: { pipeline: ['worker'], input: 'seed' } }
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: {
            loop: { pool: ['worker'], maxIterations: 3, errorHandling: { retry: { attempts: 2, backoffMs: 1 } } },
          },
        }),
        worker: defineTestAgent({ model: 'worker' }),
      },
      models: {
        host: mockScript([start, { tool: 'core_finish_loop', args: {} }, { text: 'done' }]),
        worker: mockErrorModel('worker down'),
      },
      plugins: [otel({ tracer })],
    })

    await runCollect(bread, 'host', 'go')
    await stop()

    // The first iteration failed without recovery — its loop:iteration:start
    // never got a matching loop:iteration:end — yet loop:end must still close it.
    const iterSpan = spans.find((s) => s.name === 'loop.iteration.1')
    expect(iterSpan).toBeDefined()
    expect(iterSpan!.ended).toBe(true)

    const loopSpan = spans.find((s) => s.name === 'loop.run')
    expect(loopSpan).toBeDefined()
    expect(loopSpan!.ended).toBe(true)
  })
})
