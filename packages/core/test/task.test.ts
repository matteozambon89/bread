import { describe, expect, test } from 'bun:test'
import { createTaskTool, defineTask, envProvider } from '@breadai/core'
import type { BreadCrumb, BreadPlugin, ToolContext } from '@breadai/core'
import { store } from '@breadai/store-memory'
import {
  defineTestAgent,
  makeBread,
  mockErrorModel,
  mockFlakyObjectModel,
  mockObjectModel,
  mockRecordingObjectModel,
  mockToolCallModel,
  runCollect,
} from '@breadai/test-utils'
import { z } from 'zod'

const ctx: ToolContext = { agentId: 'a', sessionId: 's', runId: 'r', credentials: envProvider() }

// An extraction task: pre loads a stored document, the model extracts entities,
// post persists each as a KG node and shapes the tool result.
function extractTask() {
  return defineTask({
    name: 'doc_extract_entities',
    description: 'Extract entities from a stored document',
    model: { provider: 'mock', model: 'm' },
    instructions: 'extract entities',
    schema: z.object({ documentId: z.string() }),
    outputSchema: z.object({
      entities: z.array(z.object({ name: z.string(), type: z.string().optional() })),
    }),
    hooks: {
      // beforeRun's returned input replaces the original args entirely (the
      // unified contract has no separate "original args" slot the way the old
      // pre/post split did), so documentId is carried forward inside it for
      // afterRun to read back.
      async beforeRun(c) {
        const args = c.input as { documentId: string }
        const doc = await c.store.readDocument?.({ agentId: c.agentId, id: args.documentId })
        if (!doc) throw new Error(`document not found: ${args.documentId}`)
        return { action: 'continue', input: { documentId: args.documentId, content: doc.content } }
      },
      async afterRun(c) {
        const out = c.output as { entities: { name: string; type?: string }[] }
        const { documentId } = c.input as { documentId: string; content: string }
        let stored = 0
        if (c.store.addKnowledgeNode) {
          for (const e of out.entities) {
            await c.store.addKnowledgeNode({ agentId: c.agentId, sessionId: c.sessionId, label: e.name })
            stored++
          }
        }
        return { output: { documentId, entities: out.entities, stored } }
      },
    },
  })
}

describe('createTaskTool', () => {
  test('exposes the task name, description and schema as a tool', () => {
    const tool = createTaskTool(extractTask(), { store: store() })
    expect(tool.name).toBe('doc_extract_entities')
    expect(tool.description).toContain('Extract entities')
  })

  test('runs pre -> model -> post, persists entities and an audited run, emits task crumbs', async () => {
    const testStore = store()
    const { id } = await testStore.ingestDocument!({
      agentId: 'a',
      title: 'T',
      content: 'Ada built engines',
    })
    const crumbs: BreadCrumb[] = []
    const tool = createTaskTool(extractTask(), {
      store: testStore,
      providers: [{ mock: () => mockObjectModel({ entities: [{ name: 'Ada', type: 'person' }] }) }],
      onCrumb: (c) => crumbs.push(c),
    })

    const result = (await tool.execute({ documentId: id }, ctx)) as {
      entities: unknown[]
      stored: number
    }
    expect(result.entities).toEqual([{ name: 'Ada', type: 'person' }])
    expect(result.stored).toBe(1)

    // The entity is persisted as a KG node.
    const nodes = await testStore.queryKnowledge!({ agentId: 'a', query: 'Ada' })
    expect(nodes.length).toBeGreaterThanOrEqual(1)

    // The run is recorded for audit.
    const runs = await testStore.listTaskRuns!()
    expect(runs.length).toBe(1)
    expect(runs[0]!.status).toBe('completed')
    expect(runs[0]!.taskId).toBe('doc_extract_entities')
    expect(runs[0]!.output).toEqual({ entities: [{ name: 'Ada', type: 'person' }] })

    // Observability crumbs bracket the model call.
    const types = crumbs.map((c) => c.type)
    expect(types).toContain('task:start')
    expect(types).toContain('task:end')
  })

  test('forwards ModelRef.settings and namespaces providerOptions under the provider', async () => {
    const testStore = store()
    const { id } = await testStore.ingestDocument!({ agentId: 'a', title: 'T', content: 'Ada built engines' })
    const { model, calls } = mockRecordingObjectModel({ entities: [{ name: 'Ada' }] })
    const task = defineTask({
      name: 'doc_extract_entities',
      description: 'Extract entities from a stored document',
      model: { provider: 'mock', model: 'm', settings: { temperature: 0.1 }, providerOptions: { think: true } },
      instructions: 'extract entities',
      schema: z.object({ documentId: z.string() }),
      outputSchema: z.object({ entities: z.array(z.object({ name: z.string() })) }),
    })
    const tool = createTaskTool(task, { store: testStore, providers: [{ mock: () => model }] })

    await tool.execute({ documentId: id }, ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.temperature).toBe(0.1)
    expect(calls[0]!.providerOptions).toEqual({ mock: { think: true } })
  })

  test('records a failed run when the model output does not match the schema', async () => {
    const testStore = store()
    const { id } = await testStore.ingestDocument!({ agentId: 'a', title: 'T', content: 'x' })
    const crumbs: BreadCrumb[] = []
    const tool = createTaskTool(extractTask(), {
      store: testStore,
      providers: [{ mock: () => mockObjectModel({ nope: true }) }],
      onCrumb: (c) => crumbs.push(c),
    })

    await expect(tool.execute({ documentId: id }, ctx)).rejects.toThrow()
    const runs = await testStore.listTaskRuns!()
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toBeTruthy()
    const end = crumbs.find((c) => c.type === 'task:end') as { status?: string } | undefined
    expect(end?.status).toBe('failed')
  })
})

describe('createTaskTool — onError/retry', () => {
  function flakyTask(overrides: Parameters<typeof defineTask>[0] extends infer T ? Partial<T> : never) {
    return defineTask({
      name: 'flaky_task',
      description: 'A task whose model call can fail',
      model: { provider: 'mock', model: 'm' },
      instructions: 'x',
      schema: z.object({ documentId: z.string() }),
      outputSchema: z.object({ entities: z.array(z.object({ name: z.string() })) }),
      ...overrides,
    })
  }

  test('onError recovers with a substitute output', async () => {
    const testStore = store()
    const task = flakyTask({
      hooks: { onError: () => ({ action: 'recover', output: { entities: [] } }) },
    })
    const tool = createTaskTool(task, { store: testStore, providers: [{ mock: () => mockErrorModel() }] })
    const result = await tool.execute({ documentId: 'x' }, ctx)
    expect(result).toEqual({ entities: [] })
  })

  test('a hook returning retry, backed by errorHandling.retry, re-invokes until it succeeds', async () => {
    const testStore = store()
    const task = flakyTask({ errorHandling: { retry: { attempts: 5, backoffMs: 1 } } })
    // A stable model instance — resolveModel is called fresh on every retry
    // attempt, so a factory that constructs a *new* mockFlakyObjectModel each
    // time would reset its own call counter and never actually succeed.
    const model = mockFlakyObjectModel(2, { entities: [{ name: 'Ada' }] })
    const tool = createTaskTool(task, { store: testStore, providers: [{ mock: () => model }] })
    const result = await tool.execute({ documentId: 'x' }, ctx)
    expect(result).toEqual({ entities: [{ name: 'Ada' }] })
  })

  test('retry exhausts errorHandling.retry.attempts and the error propagates', async () => {
    const testStore = store()
    const task = flakyTask({ errorHandling: { retry: { attempts: 2, backoffMs: 1 } } })
    const model = mockFlakyObjectModel(999, { entities: [] })
    const tool = createTaskTool(task, { store: testStore, providers: [{ mock: () => model }] })
    await expect(tool.execute({ documentId: 'x' }, ctx)).rejects.toThrow()
  })
})

describe('hooks — chain ordering (task scope)', () => {
  // Driven directly via createTaskTool (not the full agent/runner stack): a
  // task-tool is *also* a regular Tool from the runner's perspective, so
  // going through makeBread would additionally pass through Tool scope's own
  // plugin/global chain around the outer tool call — a separate, correct
  // layering (see docs/tools.md#hooks), but not what this test is isolating.
  test('task hook runs first, then plugin hooks, then BreadConfig.hooks', async () => {
    const order: string[] = []
    const testStore = store()
    const task = defineTask({
      name: 'chain_task',
      description: 'A task for chain-ordering assertions',
      model: { provider: 'mock', model: 'm' },
      instructions: 'x',
      schema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      hooks: { afterRun: () => void order.push('task') },
    })
    const plugin: Partial<BreadPlugin>['hooks'] = { afterRun: () => void order.push('plugin') }
    const tool = createTaskTool(task, {
      store: testStore,
      providers: [{ mock: () => mockObjectModel({ ok: true }) }],
      pluginHooks: [plugin],
      hooks: { afterRun: () => void order.push('global') },
    })
    await tool.execute({}, ctx)
    expect(order).toEqual(['task', 'plugin', 'global'])
  })
})

describe('runner task-tool resolution', () => {
  test('an agent calls a referenced task-tool end to end', async () => {
    const testStore = store()
    const { id } = await testStore.ingestDocument!({
      agentId: 'a',
      title: 'T',
      content: 'Ada built engines',
    })
    const { bread, stop } = await makeBread({
      models: {
        default: mockToolCallModel({
          toolName: 'task_doc_extract_entities',
          args: { documentId: id },
          then: 'done',
        }),
        m: mockObjectModel({ entities: [{ name: 'Ada' }] }),
      },
      agents: { a: defineTestAgent({ config: { tasks: ['doc_extract_entities'] } }) },
      tasks: { extract: extractTask() },
      config: { store: testStore },
    })

    const crumbs = await runCollect(bread, 'a', 'go')
    const toolResult = crumbs.find(
      (c) => c.type === 'tool:result' && (c as { toolName?: string }).toolName === 'task_doc_extract_entities',
    )
    expect(toolResult).toBeTruthy()
    expect(crumbs.map((c) => c.type)).toContain('task:end')
    expect((await testStore.queryKnowledge!({ agentId: 'a', query: 'Ada' })).length).toBeGreaterThanOrEqual(1)
    await stop()
  })

  test('an agent referencing an unknown task fails to run', async () => {
    const { bread, stop } = await makeBread({
      model: mockToolCallModel({ toolName: 'x', args: {}, then: 'done' }),
      agents: { a: defineTestAgent({ config: { tasks: ['missing'] } }) },
    })
    await expect(runCollect(bread, 'a', 'go')).rejects.toThrow(/unknown task/i)
    await stop()
  })
})
