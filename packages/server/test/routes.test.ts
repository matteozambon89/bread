import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  AgentRegistry,
  BreadConfig,
  BreadCrumb,
  BreadInstance,
  CleanupOptions,
  LoopFilter,
  LoopRecord,
  RemoteAgent,
  Session,
  TaskRunFilter,
  TaskRunRecord,
} from '@breadai/core'
import { BreadError } from '@breadai/core'
import { createServer } from '@breadai/server'
import { store } from '@breadai/store-memory'
import { transport } from '@breadai/transport-http-sse'
import { defineTestAgent, makeServer, mockProvider, mockTextModel, readSse } from '@breadai/test-utils'

describe('server — agent routes', () => {
  let app: Hono
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hello there'),
    }))
  })

  afterEach(() => stop())

  test('GET /agents lists registered agents', async () => {
    const res = await app.request('/agents')
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<{ id: string }>
    expect(list.map((a) => a.id)).toEqual(['greeter'])
  })

  test('GET /agents/:id returns the agent schema', async () => {
    const res = await app.request('/agents/greeter')
    expect(res.status).toBe(200)
    expect((await res.json()) as { id: string }).toMatchObject({ id: 'greeter' })
  })

  test('GET /agents/:id 404s for an unknown agent', async () => {
    const res = await app.request('/agents/ghost')
    expect(res.status).toBe(404)
  })

  test('POST /agents/:id/run streams crumbs as SSE', async () => {
    const res = await app.request('/agents/greeter/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const events = await readSse(res)
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('agent:run:start')
    expect(types.at(-1)).toBe('agent:run:end')
    const text = events
      .filter((e) => e.type === 'text:delta')
      .map((e) => (e.payload as { delta: string }).delta)
      .join('')
    expect(text).toBe('hello there')
  })

  test('POST /agents/:id/run surfaces an unknown agent as an in-stream error, not a 404', async () => {
    // mount() has no private registry access to pre-check existence (it would
    // also wrongly 404 an id that only exists in config.remoteAgents — see the
    // regression test below) — bread.run() throws lazily, on first iteration.
    const res = await app.request('/agents/ghost/run', { method: 'POST' })
    expect(res.status).toBe(200)
    const events = await readSse(res)
    const error = events.at(-1)!
    expect(error.type).toBe('error')
    expect((error.payload as { code: string }).code).toBe('AGENT_NOT_FOUND')
  })
})

describe('server — remote agents over the run route', () => {
  test('POST /agents/:id/run dispatches an id registered only in remoteAgents', async () => {
    const remote: RemoteAgent = {
      async *run(agentId) {
        yield {
          type: 'agent:run:end',
          agentId,
          runId: 'r',
          sessionId: 's',
          timestamp: 0,
          output: 'from-remote',
        } as BreadCrumb
      },
    }
    const { app, stop } = await makeServer({
      agents: { local: defineTestAgent() },
      model: mockTextModel('unused'),
      config: { remoteAgents: { researcher: remote } },
    })
    try {
      // Regression: the route used to 404 on remote-only ids — the local
      // registry guard ran before bread.run's remoteAgents precedence.
      const res = await app.request('/agents/researcher/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'go' }),
      })
      expect(res.status).toBe(200)
      const events = await readSse(res)
      expect(events.at(-1)!.type).toBe('agent:run:end')
      expect((events.at(-1)!.payload as { output: string }).output).toBe('from-remote')
    } finally {
      await stop()
    }
  })
})

describe('server — session cleanup route', () => {
  let app: Hono
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
    }))
  })

  afterEach(() => stop())

  test('POST /sessions/cleanup converts olderThanDays to the store\'s olderThanMs', async () => {
    let received: CleanupOptions | undefined
    const original = bread.store.cleanupSessions.bind(bread.store)
    bread.store.cleanupSessions = async (opts) => {
      received = opts
      return original(opts)
    }

    const res = await app.request('/sessions/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ olderThanDays: 30, tags: { env: 'test' } }),
    })
    expect(res.status).toBe(200)
    expect(received).toEqual({ olderThanMs: 30 * 24 * 60 * 60 * 1000, tags: { env: 'test' } })
  })

  test('POST /sessions/cleanup with an empty body passes no filters', async () => {
    let received: CleanupOptions | undefined
    bread.store.cleanupSessions = async (opts) => {
      received = opts
      return 0
    }

    const res = await app.request('/sessions/cleanup', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(received).toEqual({})
  })
})

describe('server — sessions CRUD routes', () => {
  let app: Hono
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
    }))
  })

  afterEach(() => stop())

  test('GET /sessions lists sessions from the store', async () => {
    const session: Session = { id: 's1', createdAt: 1, updatedAt: 2, tags: { env: 'prod' } }
    bread.store.listSessions = async () => [session]

    const res = await app.request('/sessions')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([session])
  })

  test('GET /sessions?tag=k:v filters by tag', async () => {
    let received: { tags?: Record<string, string> } | undefined
    bread.store.listSessions = async (filter) => {
      received = filter
      return []
    }

    const res = await app.request('/sessions?tag=env:prod')
    expect(res.status).toBe(200)
    expect(received).toEqual({ tags: { env: 'prod' } })
  })

  test('GET /sessions/:id returns the session when found', async () => {
    const session: Session = { id: 's1', createdAt: 1, updatedAt: 2, tags: {} }
    bread.store.getSession = async (id) => (id === 's1' ? session : undefined)

    const res = await app.request('/sessions/s1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(session)
  })

  test('GET /sessions/:id 404s when the session does not exist', async () => {
    bread.store.getSession = async () => undefined

    const res = await app.request('/sessions/ghost')
    expect(res.status).toBe(404)
  })

  test('DELETE /sessions/:id deletes and returns ok', async () => {
    let deletedId: string | undefined
    bread.store.deleteSession = async (id) => {
      deletedId = id
    }

    const res = await app.request('/sessions/s1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(deletedId).toBe('s1')
  })
})

describe('server — loops routes', () => {
  let app: Hono
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
    }))
  })

  afterEach(() => stop())

  const loopRecord: LoopRecord = {
    id: 'loop1',
    agentId: 'greeter',
    sessionId: 's1',
    runId: 'r1',
    pool: ['greeter'],
    pipeline: ['greeter'],
    maxIterations: 3,
    status: 'running',
    iterations: 1,
    startedAt: 1,
  }

  test('GET /loops with no query params passes no filter', async () => {
    let received: LoopFilter | undefined
    bread.store.listLoops = async (filter) => {
      received = filter
      return [loopRecord]
    }

    const res = await app.request('/loops')
    expect(res.status).toBe(200)
    expect(received).toBeUndefined()
    expect(await res.json()).toEqual([loopRecord])
  })

  test('GET /loops with session/agent/status query params builds the filter', async () => {
    let received: LoopFilter | undefined
    bread.store.listLoops = async (filter) => {
      received = filter
      return []
    }

    const res = await app.request('/loops?session=s1&agent=greeter&status=running')
    expect(res.status).toBe(200)
    expect(received).toEqual({ sessionId: 's1', agentId: 'greeter', status: 'running' })
  })

  test('GET /loops/:id returns the loop with its iterations when found', async () => {
    bread.store.getLoop = async (id) =>
      id === 'loop1' ? { loop: loopRecord, iterations: [] } : undefined

    const res = await app.request('/loops/loop1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ loop: loopRecord, iterations: [] })
  })

  test('GET /loops/:id 404s when the loop does not exist', async () => {
    bread.store.getLoop = async () => undefined

    const res = await app.request('/loops/ghost')
    expect(res.status).toBe(404)
  })
})

describe('server — task run routes', () => {
  let app: Hono
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
    }))
  })

  afterEach(() => stop())

  const taskRun: TaskRunRecord = {
    id: 't1',
    taskId: 'summarize',
    model: { provider: 'openai', model: 'gpt-4o-mini' },
    input: { text: 'x' },
    status: 'completed',
    createdAt: 1,
  }

  test('GET /tasks 501s when the store does not support listTaskRuns', async () => {
    delete (bread.store as { listTaskRuns?: unknown }).listTaskRuns

    const res = await app.request('/tasks')
    expect(res.status).toBe(501)
  })

  test('GET /tasks builds a filter from query params and lists task runs', async () => {
    let received: TaskRunFilter | undefined
    bread.store.listTaskRuns = async (filter) => {
      received = filter
      return [taskRun]
    }

    const res = await app.request('/tasks?task=summarize&session=s1&agent=greeter&status=completed&limit=5')
    expect(res.status).toBe(200)
    expect(received).toEqual({
      taskId: 'summarize',
      sessionId: 's1',
      agentId: 'greeter',
      status: 'completed',
      limit: 5,
    })
    expect(await res.json()).toEqual([taskRun])
  })

  test('GET /tasks/:id 501s when the store does not support getTaskRun', async () => {
    delete (bread.store as { getTaskRun?: unknown }).getTaskRun

    const res = await app.request('/tasks/t1')
    expect(res.status).toBe(501)
  })

  test('GET /tasks/:id returns the run when found', async () => {
    bread.store.getTaskRun = async (id) => (id === 't1' ? taskRun : undefined)

    const res = await app.request('/tasks/t1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(taskRun)
  })

  test('GET /tasks/:id 404s when the run does not exist', async () => {
    bread.store.getTaskRun = async () => undefined

    const res = await app.request('/tasks/ghost')
    expect(res.status).toBe(404)
  })
})

describe('createServer — config guards', () => {
  function baseConfig(): BreadConfig {
    return {
      entrypoints: ['greeter'],
      providers: mockProvider({ default: mockTextModel('hi') }),
    }
  }
  const agents: AgentRegistry = new Map([['greeter', defineTestAgent()]])

  test('throws STORE_NOT_CONFIGURED when config.store is unset', () => {
    const config = baseConfig()
    config.transport = transport()
    expect(() => createServer(config, agents)).toThrow(BreadError)
    try {
      createServer(config, agents)
      throw new Error('expected createServer to throw')
    } catch (err) {
      expect((err as BreadError).code).toBe('STORE_NOT_CONFIGURED')
    }
  })

  test('throws TRANSPORT_NOT_CONFIGURED when the transport has no mount()', () => {
    const config = baseConfig()
    config.store = store()
    config.transport = { capability: 'sink', publish: () => {} }
    try {
      createServer(config, agents)
      throw new Error('expected createServer to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('TRANSPORT_NOT_CONFIGURED')
    }
  })
})
