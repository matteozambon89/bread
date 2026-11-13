import { describe, expect, test } from 'bun:test'
import { BreadError, envProvider, type AgentConfig, type BreadStore, type Graph, type ToolContext, type ToolDefinition } from '@breadai/core'
import { store } from '@breadai/store-memory'
import { mockObjectModel, mockRecordingObjectModel } from '@breadai/test-utils'
import { z } from 'zod'
import { memory } from '../src/index.ts'
import { createMemoryNode } from '../src/graph-backend.ts'

const CREATE = [
  'MERGE (m:BreadMemory {id: $id})',
  'ON CREATE SET m.content = $content, m.agentId = $agentId, m.principalIss = $iss, m.principalSub = $sub, m.createdAt = $createdAt',
  'WITH m',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub',
  'RETURN m.id AS id, m.content AS content, m.createdAt AS createdAt',
].join('\n')

const SEARCH = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub AND toLower(m.content) CONTAINS toLower($query)',
  'RETURN m.id AS id, m.content AS content, m.createdAt AS createdAt',
  'ORDER BY m.createdAt DESC, m.id DESC',
  'LIMIT $limit',
].join('\n')

const LIST = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub',
  'RETURN m.id AS id, m.content AS content, m.createdAt AS createdAt',
  'ORDER BY m.createdAt DESC, m.id DESC',
  'LIMIT $limit',
].join('\n')

const READ = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub AND m.id = $id',
  'RETURN m.id AS id, m.content AS content, m.createdAt AS createdAt',
].join('\n')

const DELETE = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub AND m.id = $id',
  'WITH m, m.id AS memoryId',
  'DETACH DELETE m',
  'RETURN memoryId AS id',
].join('\n')

const DELETE_ORPHANS = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub AND NOT m.id IN $ids',
  'WITH collect(m) AS nodes',
  'FOREACH (node IN nodes | DETACH DELETE node)',
  'RETURN size(nodes) AS removed',
].join('\n')

const ada = { iss: 'https://idp.example', sub: 'ada' }
const bob = { iss: 'https://idp.example', sub: 'bob' }
const ownerFields = ['agentId', 'principal', 'iss', 'sub', 'sessionId']
const forbiddenParams = ['tenant', 'sessionId', 'subject']

interface MemoryNode {
  id: string
  content: string
  agentId: string
  principalIss: string
  principalSub: string
  createdAt: number
}

interface GraphCall {
  statement: string
  params: Record<string, unknown>
  mode: string
  signal: AbortSignal | undefined
  arity: number
}

function nodeGraph(options: {
  failWrites?: number
  throwOnDelete?: boolean
  badSearchRow?: boolean
  badDeleteRow?: boolean
  truncate?: boolean
  dropReturnedRow?: boolean
  initial?: MemoryNode[]
  onCall?: (statement: string) => void
} = {}): { graph: Graph; calls: GraphCall[]; nodes: MemoryNode[] } {
  const calls: GraphCall[] = []
  const nodes: MemoryNode[] = (options.initial ?? []).map((node) => ({ ...node }))
  let failWrites = options.failWrites ?? 0
  const truncated = options.truncate === true

  function finish(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; truncated: boolean } {
    if (options.dropReturnedRow === true && rows.length > 0) return { rows: [], truncated: true }
    return { rows, truncated }
  }

  function owned(node: MemoryNode, params: Record<string, unknown>): boolean {
    return (
      node.agentId === params.agentId &&
      node.principalIss === params.iss &&
      node.principalSub === params.sub
    )
  }

  function toRow(node: MemoryNode): Record<string, unknown> {
    return { id: node.id, content: node.content, createdAt: node.createdAt }
  }

  const graph: Graph = {
    async run(statement, params, mode, signal) {
      calls.push({
        statement,
        params: {
          ...params,
          ...(Array.isArray(params.ids) ? { ids: [...params.ids] } : {}),
        },
        mode,
        signal,
        arity: arguments.length,
      })
      options.onCall?.(statement)
      if (statement === CREATE && failWrites > 0) {
        failWrites -= 1
        throw new Error('graph write failed')
      }
      if (statement === DELETE && options.throwOnDelete) throw new Error('graph delete failed')
      if (statement === SEARCH && options.badSearchRow) {
        return { rows: [{ id: 1, statement }], truncated }
      }
      if (statement === DELETE && options.badDeleteRow) {
        return { rows: [{ id: { statement } }], truncated }
      }
      if (statement === CREATE) {
        const existing = nodes.find((node) => node.id === params.id)
        if (existing) {
          if (!owned(existing, params)) return { rows: [], truncated: false }
          return finish([toRow(existing)])
        }
        const node: MemoryNode = {
          id: String(params.id),
          content: String(params.content),
          agentId: String(params.agentId),
          principalIss: String(params.iss),
          principalSub: String(params.sub),
          createdAt: Number(params.createdAt),
        }
        nodes.push(node)
        return finish([toRow(node)])
      }
      if (statement === SEARCH || statement === LIST) {
        const limit = Number(params.limit)
        const query = statement === SEARCH ? String(params.query).toLowerCase() : undefined
        const rows = nodes
          .filter((node) => owned(node, params))
          .filter((node) => query === undefined || node.content.toLowerCase().includes(query))
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
          .slice(0, limit)
          .map(toRow)
        return finish(rows)
      }
      if (statement === READ) {
        const found = nodes.find((node) => node.id === params.id && owned(node, params))
        return finish(found ? [toRow(found)] : [])
      }
      if (statement === DELETE) {
        const index = nodes.findIndex((node) => node.id === params.id && owned(node, params))
        if (index === -1) return finish([])
        const [removed] = nodes.splice(index, 1)
        return finish([{ id: removed!.id }])
      }
      if (statement === DELETE_ORPHANS) {
        const keep = new Set(params.ids as string[])
        const removed: MemoryNode[] = []
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const node = nodes[index]!
          if (!owned(node, params) || keep.has(node.id)) continue
          removed.push(node)
          nodes.splice(index, 1)
        }
        return finish([{ removed: removed.length }])
      }
      throw new Error(`unexpected graph statement: ${statement}`)
    },
  }
  return { graph, calls, nodes }
}

function agentCfg(setting?: unknown): AgentConfig<unknown, unknown> {
  return (setting === undefined ? {} : { plugins: { memory: setting } }) as AgentConfig<unknown, unknown>
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'a',
    sessionId: 's',
    runId: 'r',
    principal: ada,
    credentials: envProvider(),
    ...over,
  }
}

function pluginTools(plugin: ReturnType<typeof memory>): Promise<ToolDefinition[]> {
  return Promise.resolve(plugin.resolveAgentTools!('a', agentCfg({})))
}

function expectOwner(params: Record<string, unknown>, extra: string[], principal = ada) {
  expect(Object.keys(params).sort()).toEqual(['agentId', 'iss', 'sub', ...extra].sort())
  for (const key of forbiddenParams) expect(params).not.toHaveProperty(key)
  expect(params.agentId).toBe('a')
  expect(params.iss).toBe(principal.iss)
  expect(params.sub).toBe(principal.sub)
}

describe('memory graph backend', () => {
  test('graph construction does not require memory methods', () => {
    const transcript = { async getMessages() { return [] } } as unknown as BreadStore
    const plugin = memory({
      backend: { kind: 'graph', graph: nodeGraph().graph, store: transcript },
      model: mockObjectModel({}),
    })
    expect(plugin.name).toBe('memory')
  })

  test('combined construction without memory methods throws STORE_NO_MEMORY', () => {
    expect(() =>
      memory({
        backend: { kind: 'combined', store: {} as BreadStore, graph: nodeGraph().graph },
        model: mockObjectModel({}),
      }),
    ).toThrow(BreadError)
    try {
      memory({
        backend: { kind: 'combined', store: {} as BreadStore, graph: nodeGraph().graph },
        model: mockObjectModel({}),
      })
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toMatchObject({
        code: 'STORE_NO_MEMORY',
        context: { missing: ['addMemory', 'searchMemories', 'listMemories', 'forgetMemory'] },
      })
    }
  })

  test('graph memorize writes an owned node and ignores forged owner args', async () => {
    const signal = new AbortController().signal
    const { graph, calls } = nodeGraph()
    const memorize = (await pluginTools(memory({
      backend: { kind: 'graph', graph, store: store() },
      model: mockObjectModel({}),
    }))).find((tool) => tool.name === 'memorize')!
    const saved = (await memorize.execute(
      { content: 'only ada', agentId: 'other', iss: 'nope' },
      ctx({ signal }),
    )) as { id: string }
    const call = calls[0]!
    expect(call.mode).toBe('write')
    expect(call.arity).toBe(4)
    expect(call.signal).toBe(signal)
    expect(call.statement).toBe(CREATE)
    expect(call.statement).toContain('BreadMemory')
    expect(call.statement).toContain('m.agentId = $agentId')
    expect(call.statement).toContain('m.principalIss = $iss')
    expect(call.statement).toContain('m.principalSub = $sub')
    expect(call.statement).not.toContain('ON MATCH SET')
    expect(call.statement).not.toContain('LOAD CSV')
    expect(call.statement).not.toContain('KitchenStation')
    expect(call.statement).not.toContain('only ada')
    expect(call.statement).not.toContain(ada.iss)
    expect(call.statement).not.toContain(ada.sub)
    expectOwner(call.params, ['id', 'content', 'createdAt'])
    expect(call.params.content).toBe('only ada')
    expect(typeof call.params.createdAt).toBe('number')
    expect(saved.id).toBe(call.params.id)
    expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  test('graph recall reads with the default limit and forget reports the row count', async () => {
    const { graph, calls } = nodeGraph()
    const tools = await pluginTools(memory({
      backend: { kind: 'graph', graph, store: store() },
      model: mockObjectModel({}),
    }))
    const memorize = tools.find((tool) => tool.name === 'memorize')!
    const recall = tools.find((tool) => tool.name === 'recall')!
    const forget = tools.find((tool) => tool.name === 'forget')!
    const saved = (await memorize.execute({ content: 'only ada' }, ctx())) as { id: string }
    calls.length = 0
    const hits = (await recall.execute({ query: 'only ada' }, ctx())) as Array<{ id: string }>
    expect(hits.map((row) => row.id)).toEqual([saved.id])
    const search = calls[0]!
    expect(search.mode).toBe('read')
    expect(search.arity).toBe(4)
    expect(search.signal).toBeUndefined()
    expect(search.statement).toBe(SEARCH)
    expect(search.statement).toContain('CONTAINS')
    expect(search.statement).not.toContain('only ada')
    expectOwner(search.params, ['query', 'limit'])
    expect(search.params.query).toBe('only ada')
    expect(search.params.limit).toBe(10)
    calls.length = 0
    await recall.execute({ query: 'only ada', limit: 3 }, ctx())
    expect(calls[0]!.params.limit).toBe(3)
    calls.length = 0
    expect(await forget.execute({ id: saved.id }, ctx())).toEqual({ deleted: true })
    const removed = calls[0]!
    expect(removed.mode).toBe('write')
    expect(removed.statement).toBe(DELETE)
    expect(removed.statement).not.toContain('only ada')
    expectOwner(removed.params, ['id'])
    expect(removed.params.id).toBe(saved.id)
    expect(await forget.execute({ id: saved.id }, ctx())).toEqual({ deleted: false })
  })

  test('a node stays inside its owner for recall and forget', async () => {
    const { graph } = nodeGraph()
    const tools = await pluginTools(memory({
      backend: { kind: 'graph', graph, store: store() },
      model: mockObjectModel({}),
    }))
    const memorize = tools.find((tool) => tool.name === 'memorize')!
    const recall = tools.find((tool) => tool.name === 'recall')!
    const forget = tools.find((tool) => tool.name === 'forget')!
    const saved = (await memorize.execute({ content: 'only ada' }, ctx())) as { id: string }
    expect(await recall.execute({ query: 'only' }, ctx({ principal: bob }))).toEqual([])
    expect(await forget.execute({ id: saved.id }, ctx({ principal: bob }))).toEqual({ deleted: false })
    const hits = (await recall.execute({ query: 'only' }, ctx())) as Array<{ id: string }>
    expect(hits.map((row) => row.id)).toEqual([saved.id])
  })

  test('a missing principal does not call the graph', async () => {
    const { graph, calls } = nodeGraph()
    const tools = await pluginTools(memory({
      backend: { kind: 'graph', graph, store: store() },
      model: mockObjectModel({}),
    }))
    expect(tools.filter((tool) => tool.ask === true).map((tool) => tool.name).sort()).toEqual(['dream', 'forget'])
    const bare = ctx({ principal: undefined })
    for (const tool of tools) {
      const shape = (tool.schema as z.ZodObject<z.ZodRawShape>).shape
      for (const field of ownerFields) expect(shape).not.toHaveProperty(field)
      const args = tool.name === 'memorize' ? { content: 'x' } : tool.name === 'recall' ? { query: 'x' } : tool.name === 'forget' ? { id: 'x' } : {}
      await expect(tool.execute(args, bare)).rejects.toMatchObject({
        code: 'MEMORY_PRINCIPAL_REQUIRED',
        context: { agentId: 'a', runId: 'r' },
      })
    }
    expect(calls).toHaveLength(0)
  })

  test('a non-record row throws MEMORY_GRAPH_ROW without the statement', async () => {
    const { graph, calls } = nodeGraph({ badSearchRow: true })
    const recall = (await pluginTools(memory({
      backend: { kind: 'graph', graph, store: store() },
      model: mockObjectModel({}),
    }))).find((tool) => tool.name === 'recall')!
    try {
      await recall.execute({ query: 'only ada' }, ctx())
      throw new Error('expected a throw')
    } catch (err) {
      const error = err as BreadError
      expect(error.code).toBe('MEMORY_GRAPH_ROW')
      expect(error.message).toBe('Memory graph row is invalid.')
      expect(error.message).not.toContain('MATCH')
      expect(error.message).not.toContain(calls[0]!.statement)
      expect(error.context).toBeUndefined()
      expect(error.cause).toBeUndefined()
    }
  })

  test('create does not overwrite another owner', async () => {
    const { graph, nodes, calls } = nodeGraph({
      initial: [{
        id: 'same',
        content: 'ada secret',
        agentId: 'a',
        principalIss: ada.iss,
        principalSub: ada.sub,
        createdAt: 5,
      }],
    })
    const scope = { agentId: 'a', principal: ada }
    const again = await createMemoryNode(graph, { id: 'same', content: 'new text', createdAt: 9 }, scope)
    expect(again.content).toBe('ada secret')
    expect(nodes[0]!.content).toBe('ada secret')
    expect(calls[0]!.statement).toBe(CREATE)
    await expect(createMemoryNode(
      graph,
      { id: 'same', content: 'bob overwrite', createdAt: 9 },
      { agentId: 'a', principal: bob },
    )).rejects.toMatchObject({
      code: 'MEMORY_GRAPH_OWNER',
      message: 'Memory graph node belongs to another owner.',
      context: { agentId: 'a' },
    })
    expect(nodes[0]!.content).toBe('ada secret')
    try {
      await createMemoryNode(
        graph,
        { id: 'same', content: 'bob overwrite', createdAt: 9 },
        { agentId: 'a', principal: bob },
      )
      throw new Error('expected a throw')
    } catch (err) {
      const error = err as BreadError
      expect(Object.keys(error.context ?? {})).toEqual(['agentId'])
      expect(JSON.stringify(error.context)).not.toContain('secret')
      expect(error.message).not.toContain('ada secret')
      expect(error.message).not.toContain('bob overwrite')
      expect(error.cause).toBeUndefined()
    }
  })

  test('a dropped create row is not an owner mismatch', async () => {
    const { graph, nodes } = nodeGraph({ dropReturnedRow: true })
    const saved = await createMemoryNode(
      graph,
      { id: 'big', content: 'huge fact', createdAt: 5 },
      { agentId: 'a', principal: ada },
    )
    expect(saved).toEqual({ id: 'big', content: 'huge fact', createdAt: 5 })
    expect(nodes.map((node) => node.content)).toEqual(['huge fact'])

    const conflict = nodeGraph({
      dropReturnedRow: true,
      initial: [{
        id: 'same',
        content: 'ada secret',
        agentId: 'a',
        principalIss: ada.iss,
        principalSub: ada.sub,
        createdAt: 5,
      }],
    })
    await expect(createMemoryNode(
      conflict.graph,
      { id: 'same', content: 'bob overwrite', createdAt: 9 },
      { agentId: 'a', principal: bob },
    )).rejects.toMatchObject({
      code: 'MEMORY_GRAPH_OWNER',
      context: { agentId: 'a' },
    })
    expect(conflict.nodes[0]!.content).toBe('ada secret')
  })

  test('truncated results are returned', async () => {
    const { graph } = nodeGraph({ truncate: true })
    const tools = await pluginTools(memory({
      backend: { kind: 'graph', graph, store: store() },
      model: mockObjectModel({}),
    }))
    await tools.find((tool) => tool.name === 'memorize')!.execute({ content: 'only ada' }, ctx())
    const hits = (await tools.find((tool) => tool.name === 'recall')!.execute({ query: 'only' }, ctx())) as unknown[]
    expect(hits).toHaveLength(1)
  })
})

describe('combined memory backend', () => {
  test('recall uses the store and does not call the graph', async () => {
    const backend = store()
    const saved = await backend.addMemory({ agentId: 'a', principal: ada, content: 'from store' })
    const { graph, calls, nodes } = nodeGraph({
      initial: [{
        id: 'decoy',
        content: 'from store',
        agentId: 'a',
        principalIss: ada.iss,
        principalSub: ada.sub,
        createdAt: saved.createdAt + 1,
      }],
    })
    const recall = (await pluginTools(memory({
      backend: { kind: 'combined', store: backend, graph },
      model: mockObjectModel({}),
    }))).find((tool) => tool.name === 'recall')!
    const hits = await recall.execute({ query: 'from store' }, ctx())
    expect(hits).toEqual([saved])
    expect(calls).toHaveLength(0)
    expect(nodes.map((node) => node.id)).toEqual(['decoy'])
  })

  test('dream does not create an id whose returned row was dropped', async () => {
    const backend = store()
    const { graph, calls, nodes } = nodeGraph({ dropReturnedRow: true })
    const tools = await pluginTools(memory({
      backend: { kind: 'combined', store: backend, graph },
      model: mockObjectModel({ memories: [] }),
    }))
    const saved = (await tools.find((tool) => tool.name === 'memorize')!.execute(
      { content: 'huge fact' },
      ctx(),
    )) as { id: string }
    expect(nodes.map((node) => node.id)).toEqual([saved.id])
    expect(calls.filter((call) => call.statement === CREATE)).toHaveLength(1)
    const extra = await backend.addMemory({ agentId: 'a', principal: ada, content: 'store only' })
    calls.length = 0
    await tools.find((tool) => tool.name === 'dream')!.execute({}, ctx())
    expect(calls.filter((call) => call.statement === CREATE).map((call) => call.params.id)).toEqual([extra.id])
    expect(calls.some((call) => call.statement === READ && call.params.id === saved.id)).toBe(true)
    expect(nodes.map((node) => node.id).sort()).toEqual([extra.id, saved.id].sort())
  })

  test('a failed graph write keeps the store row and the next dream links that id', async () => {
    const backend = store()
    const { graph, calls, nodes } = nodeGraph({ failWrites: 1 })
    const tools = await pluginTools(memory({
      backend: { kind: 'combined', store: backend, graph },
      model: mockObjectModel({ memories: [] }),
    }))
    const memorize = tools.find((tool) => tool.name === 'memorize')!
    const dreamTool = tools.find((tool) => tool.name === 'dream')!
    await expect(memorize.execute({ content: 'kept in the store' }, ctx())).rejects.toThrow('graph write failed')
    const listed = await backend.listMemories({ agentId: 'a', principal: ada })
    expect(listed.map((row) => row.id)).toEqual([calls[0]!.params.id])
    expect(calls[0]!.mode).toBe('write')
    expect(calls[0]!.statement).toBe(CREATE)
    expect(nodes).toHaveLength(0)
    await dreamTool.execute({}, ctx())
    expect(nodes.map((node) => node.id)).toEqual([listed[0]!.id])
    const repair = calls.filter((call) => call.statement === CREATE && call.params.id === listed[0]!.id)
    expect(repair).toHaveLength(2)
    expect(calls.some((call) => call.statement === READ && call.params.id === listed[0]!.id)).toBe(true)
  })

  test('a graph delete error does not delete the store row', async () => {
    const backend = store()
    const inner = backend.forgetMemory!.bind(backend)
    let forgot = 0
    backend.forgetMemory = async (input) => {
      forgot += 1
      return inner(input)
    }
    const { graph, nodes } = nodeGraph({ throwOnDelete: true })
    const tools = await pluginTools(memory({
      backend: { kind: 'combined', store: backend, graph },
      model: mockObjectModel({}),
    }))
    const saved = (await tools.find((tool) => tool.name === 'memorize')!.execute(
      { content: 'still here' },
      ctx(),
    )) as { id: string }
    await expect(tools.find((tool) => tool.name === 'forget')!.execute({ id: saved.id }, ctx())).rejects.toThrow(
      'graph delete failed',
    )
    expect(forgot).toBe(0)
    expect((await backend.listMemories({ agentId: 'a', principal: ada })).map((row) => row.id)).toEqual([saved.id])
    expect(nodes.map((node) => node.id)).toEqual([saved.id])
  })

  test('a bad delete row does not delete the store row', async () => {
    const backend = store()
    const { graph, calls } = nodeGraph({ badDeleteRow: true })
    const tools = await pluginTools(memory({
      backend: { kind: 'combined', store: backend, graph },
      model: mockObjectModel({}),
    }))
    const saved = (await tools.find((tool) => tool.name === 'memorize')!.execute(
      { content: 'still here' },
      ctx(),
    )) as { id: string }
    try {
      await tools.find((tool) => tool.name === 'forget')!.execute({ id: saved.id }, ctx())
      throw new Error('expected a throw')
    } catch (err) {
      const error = err as BreadError
      expect(error.code).toBe('MEMORY_GRAPH_ROW')
      expect(error.message).toBe('Memory graph row is invalid.')
      expect(error.message).not.toContain('MATCH')
      expect(error.message).not.toContain(calls.at(-1)!.statement)
      expect(error.context).toBeUndefined()
      expect(error.cause).toBeUndefined()
    }
    expect((await backend.listMemories({ agentId: 'a', principal: ada })).map((row) => row.id)).toEqual([saved.id])
  })

  test('forget deletes the graph node before the store row', async () => {
    const backend = store()
    const order: string[] = []
    const inner = backend.forgetMemory!.bind(backend)
    backend.forgetMemory = async (input) => {
      order.push('store')
      return inner(input)
    }
    const { graph, nodes } = nodeGraph({
      onCall(statement) {
        if (statement === DELETE) order.push('graph')
      },
    })
    const tools = await pluginTools(memory({
      backend: { kind: 'combined', store: backend, graph },
      model: mockObjectModel({}),
    }))
    const saved = (await tools.find((tool) => tool.name === 'memorize')!.execute(
      { content: 'gone' },
      ctx(),
    )) as { id: string }
    expect(await tools.find((tool) => tool.name === 'forget')!.execute({ id: saved.id }, ctx())).toEqual({
      deleted: true,
    })
    expect(order).toEqual(['graph', 'store'])
    expect(await backend.listMemories({ agentId: 'a', principal: ada })).toEqual([])
    expect(nodes).toHaveLength(0)
  })

  test('dream removes an owned graph node that has no store row', async () => {
    const backend = store()
    const saved = await backend.addMemory({ agentId: 'a', principal: ada, content: 'linked later' })
    const { graph, calls, nodes } = nodeGraph({
      initial: [
        {
          id: 'orphan',
          content: 'left behind',
          agentId: 'a',
          principalIss: ada.iss,
          principalSub: ada.sub,
          createdAt: 1,
        },
        {
          id: 'bob-node',
          content: 'bob secret',
          agentId: 'a',
          principalIss: bob.iss,
          principalSub: bob.sub,
          createdAt: 2,
        },
      ],
    })
    const dreamTool = (await pluginTools(memory({
      backend: { kind: 'combined', store: backend, graph },
      model: mockObjectModel({ memories: [] }),
    }))).find((tool) => tool.name === 'dream')!
    await dreamTool.execute({}, ctx())
    const orphanDelete = calls.find((call) => call.statement === DELETE_ORPHANS)
    expect(orphanDelete).toBeDefined()
    expect(orphanDelete!.mode).toBe('write')
    expect(orphanDelete!.statement).not.toContain(saved.id)
    expect(orphanDelete!.statement).not.toContain('orphan')
    expect(orphanDelete!.statement).not.toContain('left behind')
    expectOwner(orphanDelete!.params, ['ids'])
    expect(orphanDelete!.params.ids).toEqual([saved.id])
    expect(nodes.map((node) => node.id).sort()).toEqual(['bob-node', saved.id].sort())
  })

  test('dream skips orphan delete when the store list hits 1000', async () => {
    const backend = store()
    for (let index = 0; index < 1000; index += 1) {
      await backend.addMemory({ agentId: 'a', principal: ada, content: `row ${index}` })
    }
    const { graph, calls, nodes } = nodeGraph({
      initial: [{
        id: 'orphan',
        content: 'left behind',
        agentId: 'a',
        principalIss: ada.iss,
        principalSub: ada.sub,
        createdAt: 1,
      }],
    })
    const dreamTool = (await pluginTools(memory({
      backend: { kind: 'combined', store: backend, graph },
      model: mockObjectModel({ memories: [] }),
    }))).find((tool) => tool.name === 'dream')!
    await dreamTool.execute({}, ctx())
    expect(calls.some((call) => call.statement === DELETE_ORPHANS)).toBe(false)
    expect(nodes.some((node) => node.id === 'orphan')).toBe(true)
  })

  test('a graph repair failure is not MEMORY_DREAM_FAILED', async () => {
    const backend = store()
    await backend.addMemory({ agentId: 'a', principal: ada, content: 'kept' })
    let modelCalls = 0
    const plugin = memory({
      backend: {
        kind: 'combined',
        store: backend,
        graph: {
          async run() {
            throw new Error('link down')
          },
        },
      },
      model: () => {
        modelCalls += 1
        return mockObjectModel({ memories: [] })
      },
    })
    const dreamTool = (await pluginTools(plugin)).find((tool) => tool.name === 'dream')!
    await expect(dreamTool.execute({}, ctx())).rejects.toThrow('link down')
    expect(modelCalls).toBe(0)
    expect((await backend.listMemories({ agentId: 'a', principal: ada })).map((row) => row.content)).toEqual(['kept'])
  })
})

describe('graph dream', () => {
  test('reads the transcript from the store and forgets only loaded ids', async () => {
    const seen: string[] = []
    const transcript = {
      async getMessages(sessionId: string) {
        seen.push(sessionId)
        return [{
          id: 'm1',
          sessionId,
          role: 'user' as const,
          content: 'transcript fact about Rome',
          timestamp: 1,
        }]
      },
    } as unknown as BreadStore
    const { graph, calls, nodes } = nodeGraph()
    let current = mockObjectModel({ memories: [] })
    const plugin = memory({
      backend: { kind: 'graph', graph, store: transcript },
      model: () => current,
    })
    const tools = await pluginTools(plugin)
    const adaRow = (await tools.find((tool) => tool.name === 'memorize')!.execute(
      { content: 'old one' },
      ctx(),
    )) as { id: string }
    const bobRow = (await tools.find((tool) => tool.name === 'memorize')!.execute(
      { content: 'secret other' },
      ctx({ principal: bob }),
    )) as { id: string }
    const recording = mockRecordingObjectModel({
      memories: [{ content: 'consolidated', replaces: [adaRow.id, bobRow.id, 'not-loaded'] }],
    })
    current = recording.model
    calls.length = 0
    const result = (await tools.find((tool) => tool.name === 'dream')!.execute(
      {},
      ctx({ sessionId: 'session-7' }),
    )) as { written: Array<{ content: string }>; forgotten: string[] }
    expect(seen).toEqual(['session-7'])
    expect(JSON.stringify(recording.calls)).toContain('transcript fact about Rome')
    expect(JSON.stringify(recording.calls)).toContain(adaRow.id)
    expect(result.written.map((row) => row.content)).toEqual(['consolidated'])
    expect(result.forgotten).toEqual([adaRow.id])
    expect(calls.map((call) => call.statement)).toEqual([LIST, CREATE, DELETE])
    expect(calls[0]!.mode).toBe('read')
    expect(calls[0]!.params.limit).toBe(100)
    expect(calls[1]!.mode).toBe('write')
    expect(calls[1]!.params.content).toBe('consolidated')
    expect(calls[1]!.statement).not.toContain('consolidated')
    expect(calls[2]!.params.id).toBe(adaRow.id)
    expect(calls.some((call) => call.params.id === bobRow.id)).toBe(false)
    expect(calls.some((call) => call.params.id === 'not-loaded')).toBe(false)
    expect(nodes.map((node) => node.content).sort()).toEqual(['consolidated', 'secret other'])
  })

  test('an aborted signal rejects before Graph.run', async () => {
    const seen: string[] = []
    const transcript = {
      async getMessages(sessionId: string) {
        seen.push(sessionId)
        return []
      },
    } as unknown as BreadStore
    const { graph, calls } = nodeGraph()
    const dreamTool = (await pluginTools(memory({
      backend: { kind: 'graph', graph, store: transcript },
      model: mockObjectModel({ memories: [] }),
    }))).find((tool) => tool.name === 'dream')!
    await expect(dreamTool.execute({}, ctx({ signal: AbortSignal.abort() }))).rejects.toMatchObject({
      code: 'MEMORY_DREAM_FAILED',
      message: 'Memory dream failed',
    })
    expect(calls).toHaveLength(0)
    expect(seen).toHaveLength(0)
  })
})
