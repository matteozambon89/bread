import { describe, expect, test } from 'bun:test'
import { defineHumanTool } from '@breadai/core'
import type { BreadCrumb, BreadInstance, LoopEndCrumb, LoopHooks, ToolErrorCrumb } from '@breadai/core'
import { store as memoryStore } from '@breadai/store-memory'
import { z } from 'zod'
import {
  defineTestAgent,
  makeBread,
  mockErrorModel,
  mockScript,
  mockTextModel,
  mockToolCallModel,
  runCollect,
} from '@breadai/test-utils'
import type { ScriptStep } from '@breadai/test-utils'
import { MockLanguageModelV4 } from 'ai/test'

// Boots a `host` agent with a loop over a single `worker`, driven by a scripted
// sequence of host tool calls.
async function makeLoopBread(
  maxIterations: number,
  hostScript: ScriptStep[],
  opts: { hooks?: Partial<LoopHooks>; workerFails?: boolean } = {},
): Promise<{ bread: BreadInstance; stop: () => Promise<void> }> {
  return makeBread({
    agents: {
      host: defineTestAgent({
        model: 'host',
        config: {
          loop: {
            pool: ['worker'],
            maxIterations,
            ...(opts.hooks ? { hooks: opts.hooks } : {}),
            ...(opts.workerFails ? { errorHandling: { retry: { attempts: 2, backoffMs: 1 } } } : {}),
          },
        },
      }),
      worker: defineTestAgent({ model: 'worker' }),
    },
    models: {
      host: mockScript(hostScript),
      worker: opts.workerFails ? mockErrorModel('worker down') : mockTextModel('worker output'),
    },
  })
}

const start: ScriptStep = { tool: 'core_start_loop', args: { pipeline: ['worker'], input: 'seed' } }

describe('runner — agent-driven loops', () => {
  test('emits the loop lifecycle crumbs and records a completed loop', async () => {
    const { bread, stop } = await makeLoopBread(3, [
      start,
      { tool: 'core_finish_loop', args: { result: 'final answer' } },
      { text: 'done' },
    ])
    const crumbs = await runCollect(bread, 'host', 'go')
    const loops = await bread.store.listLoops()
    await stop()

    const types = crumbs.map((c) => c.type)
    expect(types).toContain('loop:start')
    expect(types).toContain('loop:iteration:end')
    expect((crumbs.find((c) => c.type === 'loop:end') as LoopEndCrumb).status).toBe('completed')
    expect(loops).toHaveLength(1)
    expect(loops[0]!.iterations).toBe(1)
  })

  test('iterateLoop runs the pipeline again, recording a second iteration', async () => {
    const { bread, stop } = await makeLoopBread(3, [
      start,
      { tool: 'core_iterate_loop', args: { feedback: 'try harder' } },
      { tool: 'core_finish_loop', args: {} },
      { text: 'done' },
    ])
    const crumbs = await runCollect(bread, 'host', 'go')
    const loops = await bread.store.listLoops()
    await stop()

    expect(crumbs.filter((c) => c.type === 'loop:iteration:end')).toHaveLength(2)
    expect(loops[0]!.iterations).toBe(2)
  })

  test('iterateLoop past maxIterations closes the loop as exhausted', async () => {
    const { bread, stop } = await makeLoopBread(1, [
      start,
      { tool: 'core_iterate_loop', args: {} },
      { text: 'done' },
    ])
    const crumbs = await runCollect(bread, 'host', 'go')
    const loops = await bread.store.listLoops()
    await stop()

    expect((crumbs.find((c) => c.type === 'loop:end') as LoopEndCrumb).status).toBe('exhausted')
    expect(loops[0]!.status).toBe('exhausted')
  })

  test('a loop the agent leaves open is finalized when the run ends', async () => {
    // Host starts a loop but never calls core_finish_loop; the runner closes it.
    const { bread, stop } = await makeLoopBread(3, [start, { text: 'done without finishing' }])
    const crumbs = await runCollect(bread, 'host', 'go')
    const loops = await bread.store.listLoops()
    await stop()

    expect((crumbs.find((c) => c.type === 'loop:end') as LoopEndCrumb | undefined)?.status).toBe(
      'completed',
    )
    expect(loops[0]!.status).toBe('completed')
  })
})

describe('runner — loop hooks', () => {
  test('onInit fires once, right after loop:start', async () => {
    const seen: Array<{ loopId: string; pipeline: string[]; maxIterations: number }> = []
    const { bread, stop } = await makeLoopBread(
      3,
      [start, { tool: 'core_finish_loop', args: {} }, { text: 'done' }],
      { hooks: { onInit: (ctx) => void seen.push(ctx) } },
    )
    await runCollect(bread, 'host', 'go')
    await stop()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.pipeline).toEqual(['worker'])
    expect(seen[0]?.maxIterations).toBe(3)
    expect(typeof seen[0]?.loopId).toBe('string')
  })

  test('onIterationStart/onIterationEnd fire per iteration, and onIterationEnd can replace the output', async () => {
    const starts: number[] = []
    const ends: unknown[] = []
    const { bread, stop } = await makeLoopBread(
      3,
      [
        start,
        { tool: 'core_iterate_loop', args: {} },
        { tool: 'core_finish_loop', args: {} },
        { text: 'done' },
      ],
      {
        hooks: {
          onIterationStart: (ctx) => void starts.push(ctx.iteration),
          onIterationEnd: (ctx) => {
            ends.push(ctx.output)
            return { output: 'replaced-iteration-output' }
          },
        },
      },
    )
    const crumbs = await runCollect(bread, 'host', 'go')
    await stop()
    expect(starts).toEqual([1, 2])
    expect(ends).toEqual(['worker output', 'worker output'])
    const iterationEnds = crumbs.filter((c) => c.type === 'loop:iteration:end') as Array<{
      output: unknown
    }>
    // The crumb shows the raw output — the replacement feeds forward as
    // lastOutput / the tool caller's result instead (same convention as
    // Agent/Task/Tool afterRun).
    expect(iterationEnds.map((c) => c.output)).toEqual(['worker output', 'worker output'])
  })

  test('onError recovers a failed iteration and the loop continues', async () => {
    const errors: unknown[] = []
    const { bread, stop } = await makeLoopBread(
      3,
      [start, { tool: 'core_finish_loop', args: {} }, { text: 'done' }],
      {
        workerFails: true,
        hooks: {
          onError: (ctx) => {
            errors.push(ctx.error)
            return { action: 'recover', output: 'recovered-output' }
          },
        },
      },
    )
    const crumbs = await runCollect(bread, 'host', 'go')
    const loops = await bread.store.listLoops()
    await stop()
    expect(errors).toHaveLength(1)
    expect((crumbs.find((c) => c.type === 'loop:end') as LoopEndCrumb).status).toBe('completed')
    expect(loops[0]!.status).toBe('completed')
    expect(loops[0]!.result).toBe('recovered-output')
  })

  test('onError exhausting retries surfaces a tool:error on core_start_loop', async () => {
    // core_start_loop is itself a tool, wrapped by Tool scope's own onError —
    // a live tool failure becomes an AI-SDK-absorbed tool-error part (it
    // doesn't reject the whole host run), so the observable signal is the
    // tool:error crumb, not a rejected runCollect promise.
    const { bread, stop } = await makeLoopBread(
      3,
      [start, { tool: 'core_finish_loop', args: {} }, { text: 'done' }],
      { workerFails: true },
    )
    const crumbs = await runCollect(bread, 'host', 'go')
    await stop()
    const errorCrumb = crumbs.find((c) => c.type === 'tool:error') as { toolName?: string } | undefined
    expect(errorCrumb?.toolName).toBe('core_start_loop')
  })

  test('onFinish fires for a completed loop, an exhausted loop, and a host-run-end finalize', async () => {
    const statuses: string[] = []
    const hooks: Partial<LoopHooks> = { onFinish: (ctx) => void statuses.push(ctx.status) }

    const completed = await makeLoopBread(
      3,
      [start, { tool: 'core_finish_loop', args: {} }, { text: 'done' }],
      { hooks },
    )
    await runCollect(completed.bread, 'host', 'go')
    await completed.stop()

    const exhausted = await makeLoopBread(1, [start, { tool: 'core_iterate_loop', args: {} }, { text: 'done' }], {
      hooks,
    })
    await runCollect(exhausted.bread, 'host', 'go')
    await exhausted.stop()

    const leftOpen = await makeLoopBread(3, [start, { text: 'done without finishing' }], { hooks })
    await runCollect(leftOpen.bread, 'host', 'go')
    await leftOpen.stop()

    expect(statuses).toEqual(['completed', 'exhausted', 'completed'])
  })
})

describe('runner — loop tool guard violations', () => {
  test('core_start_loop with an agent outside the configured pool surfaces LOOP_AGENT_NOT_IN_POOL', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['worker'], maxIterations: 3 } },
        }),
        worker: defineTestAgent({ model: 'worker' }),
      },
      models: {
        host: mockScript([
          { tool: 'core_start_loop', args: { pipeline: ['outsider'], input: 'seed' } },
          { text: 'done' },
        ]),
        worker: mockTextModel('worker output'),
      },
    })
    try {
      const crumbs = await runCollect(bread, 'host', 'go')
      const errorCrumb = crumbs.find((c) => c.type === 'tool:error') as ToolErrorCrumb | undefined
      expect(errorCrumb?.toolName).toBe('core_start_loop')
      expect(errorCrumb?.error.code).toBe('LOOP_AGENT_NOT_IN_POOL')
    } finally {
      await stop()
    }
  })

  test('core_start_loop with an unregistered agent (but listed in the pool) surfaces AGENT_NOT_FOUND', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['ghost'], maxIterations: 3 } },
        }),
      },
      models: {
        host: mockScript([
          { tool: 'core_start_loop', args: { pipeline: ['ghost'], input: 'seed' } },
          { text: 'done' },
        ]),
      },
    })
    try {
      const crumbs = await runCollect(bread, 'host', 'go')
      const errorCrumb = crumbs.find((c) => c.type === 'tool:error') as ToolErrorCrumb | undefined
      expect(errorCrumb?.toolName).toBe('core_start_loop')
      expect(errorCrumb?.error.code).toBe('AGENT_NOT_FOUND')
    } finally {
      await stop()
    }
  })

  test('core_finish_loop with no active loop surfaces NO_ACTIVE_LOOP', async () => {
    const { bread, stop } = await makeLoopBread(3, [
      { tool: 'core_finish_loop', args: {} },
      { text: 'done' },
    ])
    try {
      const crumbs = await runCollect(bread, 'host', 'go')
      const errorCrumb = crumbs.find((c) => c.type === 'tool:error') as ToolErrorCrumb | undefined
      expect(errorCrumb?.toolName).toBe('core_finish_loop')
      expect(errorCrumb?.error.code).toBe('NO_ACTIVE_LOOP')
    } finally {
      await stop()
    }
  })

  test('core_iterate_loop with no active loop surfaces NO_ACTIVE_LOOP', async () => {
    const { bread, stop } = await makeLoopBread(3, [
      { tool: 'core_iterate_loop', args: {} },
      { text: 'done' },
    ])
    try {
      const crumbs = await runCollect(bread, 'host', 'go')
      const errorCrumb = crumbs.find((c) => c.type === 'tool:error') as ToolErrorCrumb | undefined
      expect(errorCrumb?.toolName).toBe('core_iterate_loop')
      expect(errorCrumb?.error.code).toBe('NO_ACTIVE_LOOP')
    } finally {
      await stop()
    }
  })

  test('core_start_loop called again while a loop is already running surfaces LOOP_ALREADY_ACTIVE', async () => {
    const { bread, stop } = await makeLoopBread(3, [
      start,
      { tool: 'core_start_loop', args: { pipeline: ['worker'], input: 'seed again' } },
      { tool: 'core_finish_loop', args: {} },
      { text: 'done' },
    ])
    try {
      const crumbs = await runCollect(bread, 'host', 'go')
      const errorCrumbs = crumbs.filter((c) => c.type === 'tool:error') as ToolErrorCrumb[]
      const errorCrumb = errorCrumbs.find((c) => c.error.code === 'LOOP_ALREADY_ACTIVE')
      expect(errorCrumb?.toolName).toBe('core_start_loop')
    } finally {
      await stop()
    }
  })
})

describe('runner — loop iteration HITL', () => {
  const approve = defineHumanTool('approve', z.object({ question: z.string() }))

  function types(crumbs: BreadCrumb[]): string[] {
    return crumbs.map((c) => c.type)
  }

  test('a finished iteration still emits loop:iteration:end', async () => {
    const { bread, stop } = await makeLoopBread(3, [start, { text: 'done' }])
    try {
      const crumbs = await runCollect(bread, 'host', 'go')
      const order = types(crumbs)
      expect(order.indexOf('loop:iteration:end')).toBeGreaterThan(order.indexOf('loop:iteration:start'))
      expect(order).not.toContain('human:required')
      const loops = await bread.store.listLoops()
      expect(loops[0]!.iterations).toBe(1)
      expect(loops[0]!.status).toBe('completed')
    } finally {
      await stop()
    }
  })

  test('a human tool inside an iteration suspends the host and resume continues that iteration', async () => {
    const host = mockScript([start, { text: 'judged' }]) as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['worker'], maxIterations: 3 } },
        }),
        worker: defineTestAgent({ model: 'worker', humanTools: [approve] }),
      },
      models: {
        host,
        worker: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'worker output' }),
      },
    })
    try {
      const first = await runCollect(bread, 'host', 'go')
      const order = types(first)
      const humanAt = order.lastIndexOf('human:required')
      expect(humanAt).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('loop:iteration:end')).toBe(-1)
      expect(order.slice(humanAt)).not.toContain('loop:iteration:end')
      expect(order).not.toContain('loop:end')
      expect(order).not.toContain('agent:run:end')
      expect(
        first.some(
          (c) =>
            (c.type === 'tool:result' || c.type === 'tool:error') &&
            'toolName' in c &&
            (c.toolName === 'core_start_loop' || c.toolName === 'core_iterate_loop'),
        ),
      ).toBe(false)
      expect(host.doStreamCalls).toHaveLength(1)

      const loops = await bread.store.listLoops()
      expect(loops).toHaveLength(1)
      expect(loops[0]!.status).toBe('running')
      expect(loops[0]!.iterations).toBe(0)
      const detail = await bread.store.getLoop(loops[0]!.id)
      expect(detail?.iterations).toHaveLength(0)

      const checkpoints = await bread.store.listCheckpoints()
      expect(checkpoints).toHaveLength(2)
      const hostCp = checkpoints.find((c) => c.agentId === 'host')
      const workerCp = checkpoints.find((c) => c.agentId === 'worker')
      expect(hostCp?.toolName).toBe('core_start_loop')
      expect(hostCp?.pending).toHaveLength(1)
      expect(workerCp?.parent?.kind).toBe('pipeline')
      if (workerCp?.parent?.kind === 'pipeline') {
        expect(workerCp.parent.pipelineId).toBe(loops[0]!.id)
        expect(workerCp.parent.hostLoop?.toolName).toBe('core_start_loop')
        expect(workerCp.parent.hostLoop?.toolCallId).toBe(hostCp?.toolCallId)
        expect(workerCp.parent.hostLoop?.checkpointId).toBe(hostCp?.id)
      }

      await expect(
        (async () => {
          for await (const _ of bread.resume(hostCp!.id, { approved: true })) void _
        })(),
      ).rejects.toMatchObject({ code: 'LOOP_CHECKPOINT_NOT_RESUMABLE' })
      expect(await bread.store.listCheckpoints()).toHaveLength(2)

      const cont: BreadCrumb[] = []
      for await (const c of bread.resume(workerCp!.id, { approved: true })) cont.push(c)
      const contTypes = types(cont)
      expect(contTypes).toContain('loop:iteration:end')
      expect(contTypes.filter((t) => t === 'loop:iteration:end')).toHaveLength(1)
      expect(contTypes).toContain('loop:end')
      const hostEnd = cont.find((c) => c.type === 'agent:run:end' && (c as { agentId: string }).agentId === 'host')
      expect(hostEnd).toBeDefined()
      expect(JSON.stringify(host.doStreamCalls.at(-1)!.prompt)).toContain('worker output')

      const after = await bread.store.getLoop(loops[0]!.id)
      expect(after?.loop.iterations).toBe(1)
      expect(after?.loop.status).toBe('completed')
      expect(after?.iterations).toHaveLength(1)
      expect(after?.iterations[0]!.output).toBe('worker output')
      expect(await bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('a later suspension in the same iteration does not finalize or continue the host', async () => {
    const host = mockScript([
      { tool: 'core_start_loop', args: { pipeline: ['gate', 'second'], input: 'seed' } },
      { text: 'host done' },
    ]) as MockLanguageModelV4
    const second = mockToolCallModel({
      toolName: 'human_approve',
      args: { question: 'second?' },
      then: 'second output',
    }) as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['gate', 'second'], maxIterations: 3 } },
        }),
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        second: defineTestAgent({ model: 'second', humanTools: [approve] }),
      },
      models: {
        host,
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'gate?' }, then: 'gate output' }),
        second,
      },
    })
    try {
      const first = await runCollect(bread, 'host', 'go')
      expect(types(first)).toContain('human:required')
      expect(types(first)).not.toContain('loop:iteration:end')
      expect(second.doStreamCalls).toHaveLength(0)
      const gateCp = first.find((c) => c.type === 'human:required') as { checkpointId: string }

      const mid: BreadCrumb[] = []
      for await (const c of bread.resume(gateCp.checkpointId, { approved: true })) mid.push(c)
      expect(types(mid)).toContain('human:required')
      expect(types(mid)).not.toContain('loop:iteration:end')
      expect(types(mid)).not.toContain('loop:end')
      expect(mid.some((c) => c.type === 'agent:run:end' && (c as { agentId: string }).agentId === 'host')).toBe(
        false,
      )
      expect(host.doStreamCalls).toHaveLength(1)
      const loops = await bread.store.listLoops()
      expect(loops[0]!.iterations).toBe(0)
      expect((await bread.store.getLoop(loops[0]!.id))?.iterations).toHaveLength(0)

      const secondCp = mid.find((c) => c.type === 'human:required') as { checkpointId: string }
      const worker = (await bread.store.listCheckpoints()).find((c) => c.id === secondCp.checkpointId)
      expect(worker?.parent?.kind).toBe('pipeline')
      if (worker?.parent?.kind === 'pipeline') {
        expect(worker.parent.pipelineId).toBe(loops[0]!.id)
        expect(worker.parent.hostLoop?.toolName).toBe('core_start_loop')
      }
      const hostCp = (await bread.store.listCheckpoints()).find((c) => c.agentId === 'host')
      expect(hostCp?.pending?.length).toBe(1)
      expect(hostCp?.pending?.[0]?.childCheckpointId).toBe(secondCp.checkpointId)
      await expect(
        (async () => {
          for await (const _ of bread.resume(hostCp!.id, { approved: true })) void _
        })(),
      ).rejects.toThrow(secondCp.checkpointId)

      const cont: BreadCrumb[] = []
      for await (const c of bread.resume(secondCp.checkpointId, { approved: true })) cont.push(c)
      expect(types(cont).filter((t) => t === 'loop:iteration:end')).toHaveLength(1)
      const end = cont.find((c) => c.type === 'loop:iteration:end') as { output?: unknown }
      expect(end.output).toBe('second output')
      expect(types(cont)).toContain('loop:end')
      expect(JSON.stringify(host.doStreamCalls.at(-1)!.prompt)).toContain('second output')
      const after = await bread.store.getLoop(loops[0]!.id)
      expect(after?.loop.iterations).toBe(1)
      expect(after?.iterations).toHaveLength(1)
      expect(after?.loop.status).toBe('completed')
    } finally {
      await stop()
    }
  })

  test('suspending core_iterate_loop keeps that later iteration open until resume', async () => {
    const host = mockScript([
      start,
      { tool: 'core_iterate_loop', args: { feedback: 'again' } },
      { text: 'judged both' },
    ]) as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['worker'], maxIterations: 3 } },
        }),
        worker: defineTestAgent({ model: 'worker', humanTools: [approve] }),
      },
      models: {
        host,
        worker: mockScript([
          { tool: 'human_approve', args: { question: 'ok?' } },
          { text: 'worker output' },
          { tool: 'human_approve', args: { question: 'ok?' } },
          { text: 'worker output' },
        ]),
      },
    })
    try {
      const first = await runCollect(bread, 'host', 'go')
      const firstCp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
      expect(types(first)).not.toContain('loop:iteration:end')

      const mid: BreadCrumb[] = []
      for await (const c of bread.resume(firstCp.checkpointId, { approved: true })) mid.push(c)
      expect(types(mid).filter((t) => t === 'loop:iteration:end')).toHaveLength(1)
      expect(types(mid)).toContain('human:required')
      expect(types(mid)).not.toContain('loop:end')
      expect(mid.some((c) => c.type === 'agent:run:end' && (c as { agentId: string }).agentId === 'host')).toBe(
        false,
      )
      const loops = await bread.store.listLoops()
      expect(loops[0]!.iterations).toBe(1)
      expect(loops[0]!.status).toBe('running')

      const secondCp = mid.find((c) => c.type === 'human:required') as { checkpointId: string }
      const worker = (await bread.store.listCheckpoints()).find((c) => c.id === secondCp.checkpointId)
      expect(worker?.parent?.kind).toBe('pipeline')
      if (worker?.parent?.kind === 'pipeline') {
        expect(worker.parent.hostLoop?.toolName).toBe('core_iterate_loop')
      }

      const cont: BreadCrumb[] = []
      for await (const c of bread.resume(secondCp.checkpointId, { approved: true })) cont.push(c)
      expect(types(cont).filter((t) => t === 'loop:iteration:end')).toHaveLength(1)
      expect(types(cont)).toContain('loop:end')
      const after = await bread.store.getLoop(loops[0]!.id)
      expect(after?.loop.iterations).toBe(2)
      expect(after?.iterations).toHaveLength(2)
      expect(after?.loop.status).toBe('completed')
    } finally {
      await stop()
    }
  })

  test('resume continues a suspended iteration across a restart', async () => {
    const testStore = memoryStore()
    const host = mockScript([start, { text: 'after restart' }]) as MockLanguageModelV4
    const worker = mockToolCallModel({
      toolName: 'human_approve',
      args: { question: 'ok?' },
      then: 'worker output',
    })
    const agents = () => ({
      host: defineTestAgent({
        model: 'host',
        config: { loop: { pool: ['worker'], maxIterations: 3 } },
      }),
      worker: defineTestAgent({ model: 'worker', humanTools: [approve] }),
    })
    const a = await makeBread({
      agents: agents(),
      models: { host, worker },
      config: { store: testStore },
    })
    const first = await runCollect(a.bread, 'host', 'go')
    const workerCp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
    expect(types(first)).not.toContain('loop:iteration:end')
    await a.stop()

    const b = await makeBread({
      agents: agents(),
      models: { host, worker },
      config: { store: testStore },
    })
    try {
      const cont: BreadCrumb[] = []
      for await (const c of b.bread.resume(workerCp.checkpointId, { approved: true })) cont.push(c)
      expect(types(cont)).toContain('loop:iteration:end')
      expect(types(cont)).toContain('loop:end')
      const loops = await b.bread.store.listLoops()
      expect(loops[0]!.iterations).toBe(1)
      expect(loops[0]!.status).toBe('completed')
    } finally {
      await b.stop()
    }
  })

  test('a delegated leaf suspends the loop host instead of failing the loop', async () => {
    const host = mockScript([
      { tool: 'core_start_loop', args: { pipeline: ['boss'], input: 'seed' } },
      { text: 'host done' },
    ]) as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['boss'], maxIterations: 3 } },
        }),
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'gate' }] } },
        }),
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
      },
      models: {
        host,
        boss: mockScript([
          { tool: 'core_delegate', args: { agentId: 'gate', input: 'x' } },
          { text: 'delegated output' },
        ]),
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'yes' }),
      },
    })
    try {
      const first = await runCollect(bread, 'host', 'go')
      expect(types(first)).toContain('human:required')
      expect(types(first)).not.toContain('agent:error')
      expect(types(first)).not.toContain('loop:end')
      expect(types(first)).not.toContain('loop:iteration:end')
      const loops = await bread.store.listLoops()
      expect(loops).toHaveLength(1)
      expect(loops[0]!.status).toBe('running')
      expect(loops[0]!.iterations).toBe(0)

      const leafId = (first.find((c) => c.type === 'human:required') as { checkpointId: string }).checkpointId
      const checkpoints = await bread.store.listCheckpoints()
      const leaf = checkpoints.find((c) => c.id === leafId)
      const bossCp = checkpoints.find((c) => c.agentId === 'boss')
      const hostCp = checkpoints.find((c) => c.agentId === 'host')
      expect(leaf?.parent?.kind).toBe('supervisor')
      expect(hostCp?.pending?.[0]?.childCheckpointId).toBe(leafId)
      expect(bossCp?.parent?.kind).toBe('pipeline')
      if (bossCp?.parent?.kind === 'pipeline') {
        expect(bossCp.parent.pipelineId).toBe(loops[0]!.id)
        expect(bossCp.parent.hostLoop?.checkpointId).toBe(hostCp?.id)
        expect(bossCp.parent.hostLoop?.loopId).toBe(loops[0]!.id)
      }

      const cont: BreadCrumb[] = []
      for await (const c of bread.resume(leafId, { approved: true })) cont.push(c)
      expect(types(cont)).toContain('loop:iteration:end')
      expect(types(cont)).toContain('loop:end')
      expect(types(cont)).not.toContain('agent:error')
      const end = cont.find((c) => c.type === 'loop:iteration:end') as { output?: unknown }
      expect(end.output).toBe('delegated output')
      expect(JSON.stringify(host.doStreamCalls.at(-1)!.prompt)).toContain('delegated output')
      const after = await bread.store.getLoop(loops[0]!.id)
      expect(after?.loop.status).toBe('completed')
      expect(after?.iterations).toHaveLength(1)
      expect(await bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('a pool agent loop keeps its host link when the outer iteration suspends', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['mid'], maxIterations: 3 } },
        }),
        mid: defineTestAgent({
          model: 'mid',
          config: { loop: { pool: ['worker'], maxIterations: 3 } },
        }),
        worker: defineTestAgent({ model: 'worker', humanTools: [approve] }),
      },
      models: {
        host: mockScript([
          { tool: 'core_start_loop', args: { pipeline: ['mid'], input: 'seed' } },
          { text: 'host done' },
        ]),
        mid: mockScript([
          { tool: 'core_start_loop', args: { pipeline: ['worker'], input: 'seed' } },
          { text: 'mid done' },
        ]),
        worker: mockToolCallModel({
          toolName: 'human_approve',
          args: { question: 'ok?' },
          then: 'worker output',
        }),
      },
    })
    try {
      const first = await runCollect(bread, 'host', 'go')
      expect(types(first)).toContain('human:required')
      expect(types(first)).not.toContain('agent:error')
      expect(types(first)).not.toContain('loop:end')
      const loops = await bread.store.listLoops()
      expect(loops).toHaveLength(2)
      expect(loops.every((loop) => loop.status === 'running' && loop.iterations === 0)).toBe(true)
      const midLoop = loops.find((loop) => loop.agentId === 'mid')!
      const hostLoop = loops.find((loop) => loop.agentId === 'host')!

      const leafId = (first.find((c) => c.type === 'human:required') as { checkpointId: string }).checkpointId
      const checkpoints = await bread.store.listCheckpoints()
      const leaf = checkpoints.find((c) => c.id === leafId)
      const midCp = checkpoints.find((c) => c.agentId === 'mid')
      const hostCp = checkpoints.find((c) => c.agentId === 'host')
      expect(leaf?.parent?.kind).toBe('pipeline')
      if (leaf?.parent?.kind === 'pipeline') {
        expect(leaf.parent.pipelineId).toBe(midLoop.id)
        expect(leaf.parent.hostLoop?.loopId).toBe(midLoop.id)
        expect(leaf.parent.hostLoop?.checkpointId).toBe(midCp?.id)
      }
      expect(midCp?.parent?.kind).toBe('pipeline')
      if (midCp?.parent?.kind === 'pipeline') {
        expect(midCp.parent.pipelineId).toBe(hostLoop.id)
        expect(midCp.parent.hostLoop?.loopId).toBe(hostLoop.id)
        expect(midCp.parent.hostLoop?.checkpointId).toBe(hostCp?.id)
      }
      expect(hostCp?.pending?.[0]?.childCheckpointId).toBe(leafId)
      expect(midCp?.pending?.[0]?.childCheckpointId).toBe(leafId)

      const cont: BreadCrumb[] = []
      for await (const c of bread.resume(leafId, { approved: true })) cont.push(c)
      expect(types(cont).filter((t) => t === 'loop:iteration:end')).toHaveLength(2)
      expect(types(cont).filter((t) => t === 'loop:end')).toHaveLength(2)
      expect(types(cont)).not.toContain('agent:error')
      const afterMid = await bread.store.getLoop(midLoop.id)
      const afterHost = await bread.store.getLoop(hostLoop.id)
      expect(afterMid?.loop.status).toBe('completed')
      expect(afterMid?.iterations[0]?.output).toBe('worker output')
      expect(afterHost?.loop.status).toBe('completed')
      expect(afterHost?.iterations[0]?.output).toBe('mid done')
      expect(await bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('onIterationEnd replacement survives a later host resume', async () => {
    const testStore = memoryStore()
    const host = mockScript([
      start,
      { tool: 'human_approve', args: { question: 'host?' } },
      { tool: 'core_iterate_loop', args: {} },
      { tool: 'core_finish_loop', args: {} },
      { text: 'done' },
    ]) as MockLanguageModelV4
    const worker = mockScript([
      { tool: 'human_approve', args: { question: 'ok?' } },
      { text: 'raw-1' },
      { text: 'raw-2' },
    ])
    const agents = () => ({
      host: defineTestAgent({
        model: 'host',
        humanTools: [approve],
        config: {
          loop: {
            pool: ['worker'],
            maxIterations: 3,
            hooks: {
              onIterationEnd: (ctx) => ({ output: `repl:${String(ctx.output)}` }),
            },
          },
        },
      }),
      worker: defineTestAgent({ model: 'worker', humanTools: [approve] }),
    })
    const a = await makeBread({
      agents: agents(),
      models: { host, worker },
      config: { store: testStore },
    })
    const first = await runCollect(a.bread, 'host', 'go')
    const workerCp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
    const mid: BreadCrumb[] = []
    for await (const c of a.bread.resume(workerCp.checkpointId, { approved: true })) mid.push(c)
    const iterationEnd = mid.find((c) => c.type === 'loop:iteration:end') as { output?: unknown }
    expect(iterationEnd.output).toBe('raw-1')
    expect(JSON.stringify(host.doStreamCalls.at(-1)!.prompt)).toContain('repl:raw-1')
    expect(JSON.stringify(host.doStreamCalls.at(-1)!.prompt)).not.toContain('"output":"raw-1"')
    const hostCp = mid.find((c) => c.type === 'human:required') as { checkpointId: string }
    const loopId = (await a.bread.store.listLoops())[0]!.id
    const detail = await a.bread.store.getLoop(loopId)
    expect(detail?.iterations[0]?.output).toBe('raw-1')
    expect(detail?.loop.lastOutput).toBe('repl:raw-1')
    await a.stop()

    const b = await makeBread({
      agents: agents(),
      models: { host, worker },
      config: { store: testStore },
    })
    try {
      const cont: BreadCrumb[] = []
      for await (const c of b.bread.resume(hostCp.checkpointId, { approved: true })) cont.push(c)
      expect(types(cont)).not.toContain('agent:error')
      const after = await b.bread.store.getLoop(loopId)
      expect(after?.iterations[1]?.input).toBe('repl:raw-1')
      expect(after?.iterations[1]?.output).toBe('raw-2')
      expect(after?.loop.status).toBe('completed')
    } finally {
      await b.stop()
    }
  })

  test('errorHandling.retry does not re-run a suspended iteration', async () => {
    const worker = mockToolCallModel({
      toolName: 'human_approve',
      args: { question: 'ok?' },
      then: 'worker output',
    }) as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: {
            loop: {
              pool: ['worker'],
              maxIterations: 3,
              errorHandling: { retry: { attempts: 3, backoffMs: 1 } },
            },
          },
        }),
        worker: defineTestAgent({ model: 'worker', humanTools: [approve] }),
      },
      models: {
        host: mockScript([start, { text: 'done' }]),
        worker,
      },
    })
    try {
      const crumbs = await runCollect(bread, 'host', 'go')
      expect(types(crumbs)).toContain('human:required')
      expect(types(crumbs)).not.toContain('agent:error')
      expect(types(crumbs)).not.toContain('loop:iteration:end')
      expect(worker.doStreamCalls).toHaveLength(1)
      const loops = await bread.store.listLoops()
      expect(loops[0]!.status).toBe('running')
      expect(loops[0]!.iterations).toBe(0)
    } finally {
      await stop()
    }
  })

  test('a second loop tool call in the same turn does not drop the first suspension', async () => {
    const worker = mockToolCallModel({
      toolName: 'human_approve',
      args: { question: 'ok?' },
      then: 'worker output',
    }) as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['worker'], maxIterations: 3 } },
        }),
        worker: defineTestAgent({ model: 'worker', humanTools: [approve] }),
      },
      models: {
        host: mockScript([
          {
            tools: [
              { tool: 'core_start_loop', args: { pipeline: ['worker'], input: 'a' } },
              { tool: 'core_start_loop', args: { pipeline: ['worker'], input: 'b' } },
            ],
          },
          { text: 'done' },
        ]),
        worker,
      },
    })
    try {
      const crumbs = await runCollect(bread, 'host', 'go')
      expect(types(crumbs)).toContain('human:required')
      expect(types(crumbs)).not.toContain('agent:error')
      expect(types(crumbs)).not.toContain('loop:end')
      const toolError = crumbs.find((c) => c.type === 'tool:error') as ToolErrorCrumb | undefined
      expect(['LOOP_TOOL_IN_FLIGHT', 'LOOP_ALREADY_ACTIVE']).toContain(toolError?.error.code)
      const loops = await bread.store.listLoops()
      expect(loops.filter((loop) => loop.status === 'running')).toHaveLength(1)
      expect(loops.some((loop) => loop.status === 'failed')).toBe(false)
      const leafId = (crumbs.find((c) => c.type === 'human:required') as { checkpointId: string }).checkpointId
      const hostCp = (await bread.store.listCheckpoints()).find((c) => c.agentId === 'host')
      expect(hostCp?.pending?.[0]?.childCheckpointId).toBe(leafId)
    } finally {
      await stop()
    }
  })

  test('a later step after human resume recovers through LoopHooks.onError', async () => {
    let onErrorCalls = 0
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: {
            loop: {
              pool: ['gate', 'second'],
              maxIterations: 3,
              hooks: {
                onError: () => {
                  onErrorCalls += 1
                  return { action: 'recover', output: 'recovered' }
                },
              },
            },
          },
        }),
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        second: defineTestAgent({ model: 'second' }),
      },
      models: {
        host: mockScript([
          { tool: 'core_start_loop', args: { pipeline: ['gate', 'second'], input: 'seed' } },
          { text: 'host done' },
        ]),
        gate: mockToolCallModel({
          toolName: 'human_approve',
          args: { question: 'gate?' },
          then: 'gate output',
        }),
        second: mockErrorModel('second down'),
      },
    })
    try {
      const first = await runCollect(bread, 'host', 'go')
      expect(types(first).filter((type) => type === 'loop:iteration:start')).toHaveLength(1)
      const gateId = (first.find((c) => c.type === 'human:required') as { checkpointId: string }).checkpointId
      const loopId = (await bread.store.listLoops())[0]!.id
      const cont: BreadCrumb[] = []
      for await (const crumb of bread.resume(gateId, { approved: true })) cont.push(crumb)
      expect(onErrorCalls).toBe(1)
      expect(types(cont)).not.toContain('loop:iteration:start')
      const end = cont.find((c) => c.type === 'loop:iteration:end') as { output?: unknown }
      expect(end.output).toBe('recovered')
      const after = await bread.store.getLoop(loopId)
      expect(after?.loop.status).toBe('completed')
      expect(after?.iterations).toHaveLength(1)
      expect(after?.iterations[0]?.output).toBe('recovered')
    } finally {
      await stop()
    }
  })

  test('a claimed host that throws before its loop runtime exists fails the loop', async () => {
    const inner = memoryStore()
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['worker'], maxIterations: 3 } },
        }),
        worker: defineTestAgent({ model: 'worker', humanTools: [approve] }),
      },
      models: {
        host: mockScript([start, { text: 'host done' }]),
        worker: mockToolCallModel({
          toolName: 'human_approve',
          args: { question: 'ok?' },
          then: 'worker output',
        }),
      },
      config: {
        store: {
          ...inner,
          async getMessages(sessionId: string) {
            const loops = await inner.listLoops()
            if (loops.some((loop) => loop.sessionId === sessionId && loop.iterations > 0)) {
              throw new Error('host messages exploded')
            }
            return inner.getMessages(sessionId)
          },
        },
      },
    })
    try {
      const first = await runCollect(bread, 'host', 'go')
      const workerId = (first.find((c) => c.type === 'human:required') as { checkpointId: string }).checkpointId
      const loopId = (await bread.store.listLoops())[0]!.id
      const crumbs: BreadCrumb[] = []
      await expect(
        (async () => {
          for await (const crumb of bread.resume(workerId, { approved: true })) crumbs.push(crumb)
        })(),
      ).rejects.toThrow('host messages exploded')
      const end = crumbs.find((c) => c.type === 'loop:end') as LoopEndCrumb | undefined
      expect(end?.status).toBe('failed')
      expect((await bread.store.getLoop(loopId))?.loop.status).toBe('failed')
      expect(await bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('an agent onError recover after the host is claimed completes the loop', async () => {
    const scripted = mockScript([start, { text: 'should not run' }]) as MockLanguageModelV4
    let calls = 0
    const host = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1
        if (calls > 1) throw new Error('host continuation failed')
        return scripted.doStream(options)
      },
    })
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: {
            hooks: { onError: () => ({ action: 'recover', output: 'recovered-host' }) },
            loop: { pool: ['worker'], maxIterations: 3 },
          },
        }),
        worker: defineTestAgent({ model: 'worker', humanTools: [approve] }),
      },
      models: {
        host,
        worker: mockToolCallModel({
          toolName: 'human_approve',
          args: { question: 'ok?' },
          then: 'worker output',
        }),
      },
    })
    try {
      const first = await runCollect(bread, 'host', 'go')
      const workerId = (first.find((c) => c.type === 'human:required') as { checkpointId: string }).checkpointId
      const loopId = (await bread.store.listLoops())[0]!.id
      const cont: BreadCrumb[] = []
      for await (const crumb of bread.resume(workerId, { approved: true })) cont.push(crumb)
      const end = cont.find((c) => c.type === 'loop:end') as LoopEndCrumb | undefined
      expect(end?.status).toBe('completed')
      expect(end?.result).toBe('worker output')
      const after = await bread.store.getLoop(loopId)
      expect(after?.loop.status).toBe('completed')
      expect(after?.loop.result).toBe('worker output')
      expect(await bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('one throwing loop child leaves the host and the other child pending', async () => {
    const scripted = mockScript([
      { tool: 'human_approve', args: { question: 'one?' } },
      { text: 'should not run' },
    ]) as MockLanguageModelV4
    let calls = 0
    const g1 = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1
        if (calls > 1) throw new Error('g1 resume failed')
        return scripted.doStream(options)
      },
    })
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['boss'], maxIterations: 3 } },
        }),
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { max: 2, agents: [{ agentId: 'g1' }, { agentId: 'g2' }] } },
        }),
        g1: defineTestAgent({ model: 'g1', humanTools: [approve] }),
        g2: defineTestAgent({ model: 'g2', humanTools: [approve] }),
      },
      models: {
        host: mockScript([
          { tool: 'core_start_loop', args: { pipeline: ['boss'], input: 'seed' } },
          { text: 'host done' },
        ]),
        boss: mockScript([
          {
            tools: [
              { tool: 'core_delegate', args: { agentId: 'g1', input: 'a' } },
              { tool: 'core_delegate', args: { agentId: 'g2', input: 'b' } },
            ],
          },
          { text: 'delegated output' },
        ]),
        g1,
        g2: mockToolCallModel({ toolName: 'human_approve', args: { question: 'two?' }, then: 'second' }),
      },
    })
    try {
      const first = await runCollect(bread, 'host', 'go')
      expect(first.filter((c) => c.type === 'human:required')).toHaveLength(2)
      const checkpoints = await bread.store.listCheckpoints()
      const g1Id = checkpoints.find((cp) => cp.agentId === 'g1')!.id
      const g2Id = checkpoints.find((cp) => cp.agentId === 'g2')!.id
      const loopId = (await bread.store.listLoops())[0]!.id
      await expect(
        (async () => {
          for await (const _ of bread.resume(g1Id, { approved: true })) void _
        })(),
      ).rejects.toThrow('g1 resume failed')
      const hostCp = (await bread.store.listCheckpoints()).find((cp) => cp.agentId === 'host')
      expect(hostCp?.pending?.map((entry) => entry.childCheckpointId)).toEqual([g2Id])
      expect((await bread.store.getLoop(loopId))?.loop.status).toBe('running')
    } finally {
      await stop()
    }
  })
})
