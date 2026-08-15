import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { BreadError, type BreadConfig, type BreadInstance, type BreadPlugin, createBread, defineTask } from '@bread/core'
import { store } from '@bread/store-memory'
import { defineTestAgent, mockErrorModel, mockObjectModel, mockProvider, mockTextModel } from '@bread/test-utils'

// A memory store augmented with the optional migrate/close hooks the lifecycle
// calls — store itself defines neither, so these track the calls.
function spyStore() {
  const base = store()
  let migrated = 0
  let closed = 0
  return {
    store: { ...base, migrate: async () => void migrated++, close: async () => void closed++ },
    get migrated() {
      return migrated
    },
    get closed() {
      return closed
    },
  }
}

function baseConfig(over: Partial<BreadConfig> = {}): BreadConfig {
  return {
    entrypoints: [],
    store: store(),
    providers: mockProvider({ default: mockTextModel('ok') }),
    ...over,
  }
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) {
    // exhaust the stream so the run's inFlight counter is released
  }
}

describe('createBread — start guards', () => {
  test('start throws STORE_NOT_CONFIGURED when no store is set', async () => {
    const bread = createBread({ entrypoints: [], store: undefined as never })
    try {
      await bread.start()
      throw new Error('expected start to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('STORE_NOT_CONFIGURED')
    }
  })

  test('run, resume and store throw before start', () => {
    const bread = createBread(baseConfig())
    expect(() => bread.run('a', 'x')).toThrow(/not started/)
    expect(() => bread.resume('cp', 'x')).toThrow(/not started/)
    expect(() => bread.store).toThrow(/not started/)
  })

  test('registry getters expose agents/tasks/pluginTools after start', async () => {
    const injected = defineTestAgent()
    const bread = createBread(
      baseConfig({
        plugins: [{ name: 'contrib', agents: { injected } }],
      }),
    )
    await bread.start()
    expect(bread.agents.get('injected')).toBe(injected)
    expect(bread.tasks.size).toBe(0)
    expect(bread.pluginTools).toEqual([])
    expect(bread.credentials).toBeUndefined()
    await bread.stop()
  })
})

describe('createBread — start/stop wiring', () => {
  test('start migrates the store and runs plugin init; stop runs close and closes the store', async () => {
    const spy = spyStore()
    let initialised = 0
    let destroyed = 0
    const plugin: BreadPlugin = {
      name: 'spy_plugin',
      agents: { injected: defineTestAgent() },
      init: () => void initialised++,
      close: () => void destroyed++,
    }
    const bread = createBread(
      baseConfig({
        store: spy.store,
        providers: mockProvider({ default: mockTextModel('ran') }),
        plugins: [plugin],
      }),
      new Map(),
    )

    await bread.start()
    expect(spy.migrated).toBe(1)
    expect(initialised).toBe(1)

    // The plugin-contributed agent is reachable, proving plugin.agents merged.
    await drain(bread.run('injected', 'go'))

    await bread.stop()
    expect(destroyed).toBe(1)
    expect(spy.closed).toBe(1)
  })
})

describe('createBread — runTask', () => {
  const summarize = defineTask({
    name: 'summarize',
    description: 'Summarize text',
    model: { provider: 'mock', model: 'summarizer' },
    instructions: 'summarize',
    schema: z.object({ text: z.string() }),
    outputSchema: z.object({ summary: z.string() }),
  })

  test('runs a registered task standalone with audit attribution', async () => {
    const bread = createBread(
      baseConfig({ providers: mockProvider({ summarizer: mockObjectModel({ summary: 'short' }) }) }),
      new Map(),
      new Map([['summarize', summarize as never]]),
    )
    await bread.start()
    try {
      const out = await bread.runTask('summarize', { text: 'long text' }, { agentId: 'mcp' })
      expect(out).toEqual({ summary: 'short' })

      // Full audit treatment: the TaskRunRecord carries the attribution.
      const runs = await bread.store.listTaskRuns!({ taskId: 'summarize' })
      expect(runs).toHaveLength(1)
      expect(runs[0]!.status).toBe('completed')
      expect(runs[0]!.agentId).toBe('mcp')
    } finally {
      await bread.stop()
    }
  })

  test('throws TASK_NOT_FOUND for an unknown task id', async () => {
    const bread = createBread(baseConfig())
    await bread.start()
    try {
      await expect(bread.runTask('nope', {})).rejects.toThrow('Task not found: "nope"')
    } finally {
      await bread.stop()
    }
  })
})

describe('createBread — concurrency', () => {
  let bread: BreadInstance

  afterEach(() => bread?.stop())

  test('throws CONCURRENCY_LIMIT once max in-flight runs is reached', async () => {
    bread = createBread(
      baseConfig({ concurrency: { max: 1 } }),
      new Map([['a', defineTestAgent()]]),
    )
    await bread.start()

    // check+increment now live inside the generator body (right before the
    // try), so a run only holds its slot once actually iterated — one .next()
    // is enough to make it genuinely in-flight without draining it.
    const first = bread.run('a', 'x') as AsyncGenerator<unknown>
    await first.next()

    const second = bread.run('a', 'x') as AsyncGenerator<unknown>
    await expect(second.next()).rejects.toThrow(BreadError)
    try {
      await bread.run('a', 'x').next()
    } catch (err) {
      expect((err as BreadError).code).toBe('CONCURRENCY_LIMIT')
    }

    // Release the first run's slot for teardown.
    await first.return(undefined)
  })

  test('an un-iterated stream holds no slot — obtaining `max` of them does not block a real run', async () => {
    bread = createBread(
      baseConfig({ concurrency: { max: 1 } }),
      new Map([['a', defineTestAgent()]]),
    )
    await bread.start()

    // Obtain the generator without ever calling .next() on it — per STA-01,
    // this must not hold the single available slot.
    bread.run('a', 'x')

    // The slot is still free, so a genuinely-driven run succeeds.
    await drain(bread.run('a', 'x'))
  })

  test('releases the in-flight slot after a run completes', async () => {
    bread = createBread(
      baseConfig({ concurrency: { max: 1 } }),
      new Map([['a', defineTestAgent()]]),
    )
    await bread.start()

    await drain(bread.run('a', 'x'))
    // The slot is free again, so a second run does not throw.
    await drain(bread.run('a', 'x'))
  })

  test('releases the in-flight slot after a run throws', async () => {
    bread = createBread(
      baseConfig({
        concurrency: { max: 1 },
        providers: mockProvider({ default: mockTextModel('ok'), erroring: mockErrorModel() }),
      }),
      new Map([
        ['broken', defineTestAgent({ model: 'erroring' })],
        ['ok', defineTestAgent({ model: 'default' })],
      ]),
    )
    await bread.start()

    await expect(drain(bread.run('broken', 'x'))).rejects.toThrow()
    // The failed run's finally must still have decremented inFlight — a
    // different run now succeeds instead of hitting CONCURRENCY_LIMIT.
    await drain(bread.run('ok', 'x'))
  })

  test('resume() enforces the cap while a run is mid-flight', async () => {
    bread = createBread(
      baseConfig({ concurrency: { max: 1 } }),
      new Map([['a', defineTestAgent()]]),
    )
    await bread.start()

    const first = bread.run('a', 'x') as AsyncGenerator<unknown>
    await first.next() // makes the run genuinely in-flight, holding the slot

    const resumeGen = bread.resume('nonexistent-checkpoint', {})
    await expect(resumeGen.next()).rejects.toThrow(BreadError)
    try {
      await bread.resume('nonexistent-checkpoint', {}).next()
    } catch (err) {
      expect((err as BreadError).code).toBe('CONCURRENCY_LIMIT')
    }

    await first.return(undefined)
  })

  test('run(..., { mode: "sync" }) enforces the cap while a run is mid-flight', async () => {
    bread = createBread(
      baseConfig({ concurrency: { max: 1 } }),
      new Map([['a', defineTestAgent()]]),
    )
    await bread.start()

    const first = bread.run('a', 'x') as AsyncGenerator<unknown>
    await first.next() // makes the run genuinely in-flight, holding the slot

    // Unlike stream mode (whose check+increment lives inside the generator
    // body, deferred to first .next()), sync mode's check+increment sits
    // directly in run() before the IIFE — so it throws synchronously, not as
    // a rejected promise.
    expect(() => bread.run('a', 'x', { mode: 'sync' })).toThrow(BreadError)
    try {
      bread.run('a', 'x', { mode: 'sync' })
    } catch (err) {
      expect((err as BreadError).code).toBe('CONCURRENCY_LIMIT')
    }

    await first.return(undefined)
  })

  test('runPipeline() enforces the cap while a run is mid-flight', async () => {
    bread = createBread(
      baseConfig({
        concurrency: { max: 1 },
        pipelines: { p: [{ type: 'agent', agentId: 'a' }] },
      }),
      new Map([['a', defineTestAgent()]]),
    )
    await bread.start()

    const first = bread.run('a', 'x') as AsyncGenerator<unknown>
    await first.next() // makes the run genuinely in-flight, holding the slot

    const pipelineGen = bread.runPipeline('p', 'x') as AsyncGenerator<unknown>
    await expect(pipelineGen.next()).rejects.toThrow(BreadError)
    try {
      await (bread.runPipeline('p', 'x') as AsyncGenerator<unknown>).next()
    } catch (err) {
      expect((err as BreadError).code).toBe('CONCURRENCY_LIMIT')
    }

    await first.return(undefined)
  })

  test('runTask() enforces the cap while a run is mid-flight, and releases its own slot', async () => {
    const summarize = defineTask({
      name: 'summarize',
      description: 'Summarize text',
      model: { provider: 'mock', model: 'summarizer' },
      instructions: 'summarize',
      schema: z.object({ text: z.string() }),
      outputSchema: z.object({ summary: z.string() }),
    })
    bread = createBread(
      baseConfig({
        concurrency: { max: 1 },
        providers: mockProvider({
          default: mockTextModel('ok'),
          summarizer: mockObjectModel({ summary: 'short' }),
        }),
      }),
      new Map([['a', defineTestAgent()]]),
      new Map([['summarize', summarize as never]]),
    )
    await bread.start()

    const first = bread.run('a', 'x') as AsyncGenerator<unknown>
    await first.next() // makes the run genuinely in-flight, holding the slot

    await expect(bread.runTask('summarize', { text: 'x' })).rejects.toThrow(BreadError)
    try {
      await bread.runTask('summarize', { text: 'x' })
    } catch (err) {
      expect((err as BreadError).code).toBe('CONCURRENCY_LIMIT')
    }

    await first.return(undefined) // free the slot

    // Under the cap, runTask succeeds and releases its own slot afterward.
    const out = await bread.runTask('summarize', { text: 'x' })
    expect(out).toEqual({ summary: 'short' })
    await drain(bread.run('a', 'x'))
  })
})
