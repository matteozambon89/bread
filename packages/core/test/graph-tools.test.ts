import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { collect, defineTestAgent, makeBread, mockScript, runCollect } from '@breadai/test-utils'
import { envProvider } from '../src/credentials.js'
import { assembleTools } from '../src/runner-tool-assembly.js'
import type { RunnerContext } from '../src/runner-types.js'
import type { Graph, GraphQuery, GraphResult } from '../src/storage/graph.js'
import type { AgentConfig, HumanRequiredCrumb, ToolContext } from '../src/types.js'
import { BreadError } from '../src/types.js'

const CATALOG = 'MATCH (n) WHERE n.name = $from RETURN n.name AS name'
const MARK = 'MATCH (n {name: $station}) RETURN n.name AS station'

function agent(extra: Partial<AgentConfig<string, string>> = {}): AgentConfig<string, string> {
  return {
    model: { provider: 'mock', model: 'default' },
    inputSchema: z.string(),
    outputSchema: z.string(),
    output: { format: 'text' },
    ...extra,
  }
}

function ctx(partial: Partial<RunnerContext> = {}): RunnerContext {
  return {
    store: {} as RunnerContext['store'],
    executionId: 'exec',
    agents: new Map(),
    ...partial,
  }
}

function query(partial: Partial<GraphQuery> & Pick<GraphQuery, 'mode'>): GraphQuery {
  return {
    description: partial.description ?? 'query',
    statement: partial.statement ?? CATALOG,
    schema: partial.schema ?? z.object({ from: z.string() }),
    ...partial,
  }
}

function fakeGraph(thrown?: unknown): {
  graph: Graph
  calls: Array<{ statement: string; params: Record<string, unknown>; mode: string; arity: number }>
} {
  const calls: Array<{ statement: string; params: Record<string, unknown>; mode: string; arity: number }> = []
  return {
    calls,
    graph: {
      async run(statement, params, mode, signal) {
        calls.push({ statement, params, mode, arity: signal === undefined ? 3 : 4 })
        if (thrown) throw thrown
        const result: GraphResult = { rows: [{ name: 'prep' }], truncated: false }
        return result
      },
    },
  }
}

function toolCtx(partial: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'walker',
    sessionId: 'session-1',
    runId: 'run-1',
    credentials: envProvider(),
    ...partial,
  }
}

async function execute(
  name: string,
  graphQuery: GraphQuery,
  graph: Graph,
  args: unknown,
  tool: Partial<ToolContext> = {},
): Promise<unknown> {
  const assembled = await assembleTools(
    'walker',
    agent({ graph: [name] }),
    'run-1',
    'session-1',
    {},
    ctx({ graph, graphCatalog: { [name]: graphQuery } }),
    () => {},
  )
  const entry = assembled.executables.get(`core_${name}`)
  if (!entry) throw new Error(`missing core_${name}`)
  return entry.def.execute(args, toolCtx(tool))
}

describe('graph catalog tools', () => {
  test('a read opt-in builds core_next_station and does not gate it', async () => {
    const { graph } = fakeGraph()
    const assembled = await assembleTools(
      'walker',
      agent({ graph: ['next_station'] }),
      'run',
      'session',
      {},
      ctx({
        graph,
        graphCatalog: { next_station: query({ mode: 'read', description: 'Next station' }) },
      }),
      () => {},
    )
    expect(assembled.executables.has('core_next_station')).toBe(true)
    expect(assembled.executables.get('core_next_station')?.def.ask).toBeUndefined()
    expect(assembled.gated.has('core_next_station')).toBe(false)
  })

  test('a write leaf is gated unless an exact allow entry opts out', async () => {
    const catalog = {
      mark_visited: query({
        mode: 'write',
        schema: z.object({ station: z.string() }),
        statement: MARK,
        requireTenant: false,
      }),
    }
    const base = { graph: fakeGraph().graph, graphCatalog: catalog }
    const gated = await assembleTools('walker', agent({ graph: ['mark_visited'] }), 'run', 'session', {}, ctx(base), () => {})
    expect(gated.gated.has('core_mark_visited')).toBe(true)
    expect(gated.executables.get('core_mark_visited')?.def.ask).toBe(true)

    const allowed = await assembleTools(
      'walker',
      agent({ graph: ['mark_visited'], permissions: { allow: ['core:mark_visited'] } }),
      'run',
      'session',
      {},
      ctx(base),
      () => {},
    )
    expect(allowed.gated.has('core_mark_visited')).toBe(false)

    const glob = await assembleTools(
      'walker',
      agent({ graph: ['mark_visited'], permissions: { allow: ['core:*'] } }),
      'run',
      'session',
      {},
      ctx(base),
      () => {},
    )
    expect(glob.gated.has('core_mark_visited')).toBe(true)

    const asked = await assembleTools(
      'walker',
      agent({
        graph: ['mark_visited'],
        permissions: { allow: ['core:mark_visited'], ask: ['core:mark_visited'] },
      }),
      'run',
      'session',
      {},
      ctx(base),
      () => {},
    )
    expect(asked.gated.has('core_mark_visited')).toBe(true)
  })

  test('unknown name, missing graph, invalid schema, and reserved parameters fail closed', async () => {
    const { graph } = fakeGraph()
    await expect(
      assembleTools(
        'walker',
        agent({ graph: ['missing'] }),
        'run',
        'session',
        {},
        ctx({ graph, graphCatalog: { stations: query({ mode: 'read', schema: z.object({}) }) } }),
        () => {},
      ),
    ).rejects.toMatchObject({
      message: 'Graph query not found.',
      code: 'GRAPH_QUERY_NOT_FOUND',
      context: { agentId: 'walker', name: 'missing', available: ['stations'] },
    })

    await expect(
      assembleTools('walker', agent({ graph: ['stations'] }), 'run', 'session', {}, ctx({}), () => {}),
    ).rejects.toMatchObject({
      message: 'Graph is not configured.',
      code: 'GRAPH_NOT_CONFIGURED',
      context: { agentId: 'walker' },
    })

    await expect(
      assembleTools(
        'walker',
        agent({ graph: ['stations'], documents: {} }),
        'run',
        'session',
        {},
        ctx({
          graph,
          graphCatalog: { stations: query({ mode: 'read', schema: z.string() as z.ZodType }) },
          store: {
            readDocument: async () => undefined,
            searchDocuments: async () => [],
            ingestDocument: async () => ({ id: '1', title: 't' }),
          } as unknown as RunnerContext['store'],
        }),
        () => {},
      ),
    ).rejects.toMatchObject({ message: 'Graph query schema must be an object.', code: 'GRAPH_QUERY_INVALID' })

    await expect(
      assembleTools(
        'walker',
        agent({ graph: ['doc_search'], documents: {} }),
        'run',
        'session',
        {},
        ctx({
          graph,
          graphCatalog: { doc_search: query({ mode: 'read', schema: z.object({}), statement: 'RETURN 1' }) },
          store: {
            readDocument: async () => undefined,
            searchDocuments: async () => [],
            ingestDocument: async () => ({ id: '1', title: 't' }),
          } as unknown as RunnerContext['store'],
        }),
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'TOOL_NAME_COLLISION' })

    await expect(
      assembleTools(
        'walker',
        agent({ graph: ['stations'] }),
        'run',
        'session',
        {},
        ctx({
          graph,
          graphCatalog: {
            stations: query({ mode: 'read', schema: z.object({ statement: z.string() }) }),
          },
        }),
        () => {},
      ),
    ).rejects.toMatchObject({
      message: 'Graph parameter is reserved.',
      code: 'GRAPH_PARAM_RESERVED',
      context: { query: 'stations' },
    })
  })

  test('execute rebinds the run and keeps the catalog statement', async () => {
    const { graph, calls } = fakeGraph()
    await execute(
      'next_station',
      query({ mode: 'read' }),
      graph,
      { from: 'prep', agentId: 'forged', sessionId: 'forged', tenant: 'forged', subject: 'forged', statement: 'RETURN 1' },
      { principal: { iss: 'https://idp.example', sub: 'ada', tenant: 'acme' } },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.statement).toBe(CATALOG)
    expect(calls[0]?.arity).toBe(3)
    expect(calls[0]?.params).toEqual({
      from: 'prep',
      agentId: 'walker',
      sessionId: 'session-1',
      tenant: 'acme',
      subject: 'ada',
    })
  })

  test('a missing principal binds tenant and subject to null', async () => {
    const { graph, calls } = fakeGraph()
    await execute('next_station', query({ mode: 'read' }), graph, { from: 'prep' })
    expect(calls[0]?.params.tenant).toBeNull()
    expect(calls[0]?.params.subject).toBeNull()
    expect(Object.hasOwn(calls[0]?.params ?? {}, 'tenant')).toBe(true)
  })

  test('a write with no tenant does not run unless the query opts out', async () => {
    const denied = fakeGraph()
    await expect(
      execute(
        'mark_visited',
        query({ mode: 'write', schema: z.object({ station: z.string() }), statement: MARK }),
        denied.graph,
        { station: 'prep' },
      ),
    ).rejects.toMatchObject({
      message: 'Graph query requires a tenant.',
      code: 'GRAPH_TENANT_REQUIRED',
      context: { query: 'mark_visited' },
    })
    expect(denied.calls).toHaveLength(0)

    const allowed = fakeGraph()
    await execute(
      'mark_visited',
      query({
        mode: 'write',
        schema: z.object({ station: z.string() }),
        statement: MARK,
        requireTenant: false,
      }),
      allowed.graph,
      { station: 'prep' },
    )
    expect(allowed.calls[0]?.params.tenant).toBeNull()
    expect(allowed.calls).toHaveLength(1)
  })

  test('LOAD CSV and APOC fetch or cypher calls reject any parameter', async () => {
    const cases: Array<{ statement: string; schema: z.ZodType; args: unknown }> = [
      {
        statement: 'LOAD CSV FROM $url AS row RETURN row',
        schema: z.object({ url: z.string() }),
        args: { url: 'http://169.254.169.254/' },
      },
      {
        statement: 'LOAD CSV FROM "file:///stations.csv" AS row RETURN $name',
        schema: z.object({ name: z.string() }),
        args: { name: 'notes' },
      },
      {
        statement: 'LOAD /*x*/ CSV FROM $file.url AS row RETURN row',
        schema: z.object({ file: z.object({ url: z.string() }) }),
        args: { file: { url: 'http://169.254.169.254/' } },
      },
      {
        statement: 'CALL apoc.load.json($url) YIELD value RETURN value',
        schema: z.object({ url: z.string() }),
        args: { url: 'http://169.254.169.254/' },
      },
      {
        statement: 'CALL apoc.cypher.run($query, {}) YIELD value RETURN value',
        schema: z.object({ query: z.string() }),
        args: { query: 'MATCH (n) RETURN n' },
      },
      {
        statement: 'CALL apoc.import.csv($file) YIELD value RETURN value',
        schema: z.object({ file: z.string() }),
        args: { file: 'stations.csv' },
      },
    ]
    for (const entry of cases) {
      const { graph, calls } = fakeGraph()
      await expect(
        execute('next_station', query({ mode: 'read', statement: entry.statement, schema: entry.schema }), graph, entry.args),
      ).rejects.toMatchObject({
        message: 'Graph parameter is not allowed.',
        code: 'GRAPH_PARAM_REJECTED',
        context: { query: 'next_station' },
      })
      expect(calls).toHaveLength(0)
    }

    const plain = fakeGraph()
    await execute(
      'next_station',
      query({
        mode: 'read',
        statement: 'MATCH (n) WHERE n.url = $url RETURN n.name AS name',
        schema: z.object({ url: z.string() }),
      }),
      plain.graph,
      { url: 'http://169.254.169.254/' },
    )
    expect(plain.calls).toHaveLength(1)
    expect(plain.calls[0]?.params.url).toBe('http://169.254.169.254/')

    const authored = fakeGraph()
    await execute(
      'stations',
      query({
        mode: 'read',
        statement: "LOAD CSV FROM 'file:///stations.csv' AS row RETURN row",
        schema: z.object({}),
      }),
      authored.graph,
      {},
    )
    expect(authored.calls).toHaveLength(1)
  })

  test('a driver error becomes the fixed query failure', async () => {
    const dirty = new BreadError('connection refused bolt://secret', 'DRIVER_DOWN', { url: 'bolt://secret' }, new Error('bolt://secret'))
    for (const thrown of [new Error('connection refused bolt://secret'), dirty]) {
      const { graph } = fakeGraph(thrown)
      try {
        await execute('next_station', query({ mode: 'read' }), graph, { from: 'prep' })
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(BreadError)
        const bread = err as BreadError
        expect(bread.message).toBe('Graph query failed.')
        expect(bread.code).toBe('GRAPH_QUERY_FAILED')
        expect(bread.context).toEqual({ query: 'next_station' })
        expect(bread.cause).toBeUndefined()
        expect(JSON.stringify(bread.context)).not.toContain('secret')
      }
    }
  })
})

describe('graph resume', () => {
  test('an ask-gated write runs only after approval and rebinds the checkpoint principal', async () => {
    const calls: Array<Record<string, unknown>> = []
    const graph: Graph = {
      async run(_statement, params) {
        calls.push(params)
        return { rows: [{ station: 'prep' }], truncated: false }
      },
    }
    const { bread, stop } = await makeBread({
      agents: {
        walker: defineTestAgent({
          config: { graph: ['mark_visited'] },
        }),
      },
      model: mockScript([
        {
          tool: 'core_mark_visited',
          args: { station: 'prep', tenant: 'forged', subject: 'forged', agentId: 'forged', sessionId: 'forged' },
        },
        { text: 'done' },
      ]),
      config: {
        graph,
        graphCatalog: {
          mark_visited: {
            description: 'Mark a station visited',
            statement: MARK,
            mode: 'write',
            requireTenant: false,
            schema: z.object({ station: z.string() }),
          },
        },
      },
    })
    try {
      const first = await runCollect(bread, 'walker', 'go', {
        principal: { iss: 'https://idp.example', sub: 'ada', tenant: 'acme' },
      })
      const required = first.at(-1) as HumanRequiredCrumb
      expect(required?.type).toBe('human:required')
      expect(calls).toHaveLength(0)
      await collect(bread.resume(required.checkpointId, { approved: true }))
      expect(calls).toEqual([
        {
          station: 'prep',
          agentId: 'walker',
          sessionId: required.sessionId,
          tenant: 'acme',
          subject: 'ada',
        },
      ])
    } finally {
      await stop()
    }
  })
})

describe('kitchen catalog', () => {
  test('every bound node is tenant-scoped and created visits keep $tenant', () => {
    const source = readFileSync(join(import.meta.dir, '../../../examples/kitchen/bread.config.ts'), 'utf8')
    const bound = [...source.matchAll(/\((\w+)\.tenant IS NULL AND \$tenant IS NULL\) OR \1\.tenant = \$tenant/g)].map(
      (match) => match[1],
    )
    expect(bound.sort()).toEqual(['from', 'next', 'node', 'node'])
    expect(source).toContain('visit.tenant = $tenant')
    expect(source).not.toContain('$tenant IS NULL OR')
    expect(source).toContain('requireTenant: false')
    expect(source).not.toContain('permissions')
    expect(source).not.toContain('user:secret')
  })
})
