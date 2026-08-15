import { describe, expect, test } from 'bun:test'
import type { BreadCrumb, BreadInstance, LoopEndCrumb, LoopHooks, ToolErrorCrumb } from '@breadai/core'
import {
  defineTestAgent,
  makeBread,
  mockErrorModel,
  mockScript,
  mockTextModel,
  runCollect,
} from '@breadai/test-utils'
import type { ScriptStep } from '@breadai/test-utils'

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
