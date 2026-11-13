import { describe, expect, test } from 'bun:test'
import { BreadError, envProvider, type AgentConfig, type BreadStore, type ToolContext, type ToolDefinition } from '@breadai/core'
import { store } from '@breadai/store-memory'
import { mockObjectModel, mockRecordingObjectModel } from '@breadai/test-utils'
import { z } from 'zod'
import { memory } from '@breadai/memory'

const ownerFields = ['agentId', 'principal', 'iss', 'sub', 'sessionId']
const ada = { iss: 'https://idp.example', sub: 'ada' }
const bob = { iss: 'https://idp.example', sub: 'bob' }

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

function toolsOf(plugin: ReturnType<typeof memory>, setting: unknown): Promise<ToolDefinition[]> {
  return Promise.resolve(plugin.resolveAgentTools!('a', agentCfg(setting)))
}

function argsFor(name: string): unknown {
  if (name === 'memorize') return { content: 'x' }
  if (name === 'recall') return { query: 'x' }
  if (name === 'forget') return { id: 'x' }
  return {}
}

describe('memory plugin', () => {
  test('tools attach only when the agent opts in', async () => {
    const plugin = memory({ backend: { kind: 'store', store: store() }, model: mockObjectModel({}) })
    expect(await plugin.resolveAgentTools!('a', {} as AgentConfig<unknown, unknown>)).toEqual([])
    expect(await plugin.resolveAgentTools!('a', { plugins: {} } as AgentConfig<unknown, unknown>)).toEqual([])
    expect(await toolsOf(plugin, null)).toEqual([])
    expect(await toolsOf(plugin, false)).toEqual([])
    const tools = await toolsOf(plugin, {})
    expect(tools.map((tool) => tool.name).sort()).toEqual(['dream', 'forget', 'memorize', 'recall'])
    expect(tools.filter((tool) => tool.ask === true).map((tool) => tool.name).sort()).toEqual(['dream', 'forget'])
  })

  test('schemas have no owner fields', async () => {
    const plugin = memory({ backend: { kind: 'store', store: store() }, model: mockObjectModel({}) })
    const tools = await toolsOf(plugin, {})
    for (const tool of tools) {
      const shape = (tool.schema as z.ZodObject<z.ZodRawShape>).shape
      for (const field of ownerFields) expect(shape).not.toHaveProperty(field)
    }
  })

  test('recall and forget stay inside the principal', async () => {
    const backend = store()
    const plugin = memory({ backend: { kind: 'store', store: backend }, model: mockObjectModel({}) })
    const tools = await toolsOf(plugin, {})
    const memorize = tools.find((tool) => tool.name === 'memorize')!
    const recall = tools.find((tool) => tool.name === 'recall')!
    const forget = tools.find((tool) => tool.name === 'forget')!
    const saved = (await memorize.execute({ content: 'only ada' }, ctx())) as { id: string }
    expect(await recall.execute({ query: 'only' }, ctx({ principal: bob }))).toEqual([])
    expect(await forget.execute({ id: saved.id }, ctx({ principal: bob }))).toEqual({ deleted: false })
    const hits = (await recall.execute({ query: 'only' }, ctx())) as Array<{ id: string }>
    expect(hits.map((row) => row.id)).toEqual([saved.id])
  })

  test('a missing principal is rejected on every tool', async () => {
    const plugin = memory({ backend: { kind: 'store', store: store() }, model: mockObjectModel({}) })
    const tools = await toolsOf(plugin, {})
    const bare = ctx({ principal: undefined })
    for (const tool of tools) {
      await expect(tool.execute(argsFor(tool.name), bare)).rejects.toMatchObject({
        code: 'MEMORY_PRINCIPAL_REQUIRED',
        context: { agentId: 'a', runId: 'r' },
      })
    }
  })

  test('a store without memory methods throws STORE_NO_MEMORY', () => {
    expect(() =>
      memory({ backend: { kind: 'store', store: {} as BreadStore }, model: mockObjectModel({}) }),
    ).toThrow(BreadError)
    try {
      memory({ backend: { kind: 'store', store: {} as BreadStore }, model: mockObjectModel({}) })
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toMatchObject({
        code: 'STORE_NO_MEMORY',
        context: { missing: ['addMemory', 'searchMemories', 'listMemories', 'forgetMemory'] },
      })
    }
  })

  test('dream writes a consolidated row and forgets only loaded ids', async () => {
    const backend = store()
    const session = await backend.createSession()
    await backend.addMessage(session.id, {
      role: 'user',
      content: 'transcript fact about Rome',
      timestamp: Date.now(),
    })
    const first = await backend.addMemory!({ agentId: 'a', principal: ada, content: 'old one' })
    const second = await backend.addMemory!({ agentId: 'a', principal: ada, content: 'old two' })
    const theirs = await backend.addMemory!({ agentId: 'a', principal: bob, content: 'secret other' })
    const { model, calls } = mockRecordingObjectModel({
      memories: [
        {
          content: 'consolidated',
          replaces: [first.id, second.id, theirs.id, 'not-loaded'],
        },
      ],
    })
    const plugin = memory({
      backend: { kind: 'store', store: backend },
      model: () => model,
    })
    const dream = (await toolsOf(plugin, {})).find((tool) => tool.name === 'dream')!
    const result = (await dream.execute({}, ctx({ sessionId: session.id }))) as {
      written: Array<{ id: string; content: string }>
      forgotten: string[]
    }
    const recorded = JSON.stringify(calls)
    expect(recorded).toContain(first.id)
    expect(recorded).toContain(second.id)
    expect(recorded).toContain('transcript fact about Rome')
    expect(result.written.map((row) => row.content)).toEqual(['consolidated'])
    expect(result.forgotten.sort()).toEqual([first.id, second.id].sort())
    expect((await backend.listMemories!({ agentId: 'a', principal: ada })).map((row) => row.id)).toEqual([
      result.written[0]!.id,
    ])
    expect((await backend.listMemories!({ agentId: 'a', principal: bob })).map((row) => row.id)).toEqual([
      theirs.id,
    ])
  })

  test('a dream model failure keeps a fixed message', async () => {
    const plugin = memory({
      backend: { kind: 'store', store: store() },
      model: () => {
        throw new Error('prompt secret transcript should not leak')
      },
    })
    const dream = (await toolsOf(plugin, {})).find((tool) => tool.name === 'dream')!
    await expect(dream.execute({}, ctx())).rejects.toMatchObject({
      name: 'BreadError',
      code: 'MEMORY_DREAM_FAILED',
      message: 'Memory dream failed',
      context: { agentId: 'a', runId: 'r' },
    })
    try {
      await dream.execute({}, ctx())
      throw new Error('expected a throw')
    } catch (err) {
      const error = err as BreadError
      expect(error.message).toBe('Memory dream failed')
      expect(JSON.stringify(error.context)).not.toContain('transcript')
      expect(error.cause).toBeInstanceOf(Error)
      expect((error.cause as Error).message).toContain('transcript')
    }
  })

  test('an aborted signal rejects dream', async () => {
    const plugin = memory({
      backend: { kind: 'store', store: store() },
      model: mockObjectModel({ memories: [] }),
    })
    const dream = (await toolsOf(plugin, {})).find((tool) => tool.name === 'dream')!
    const signal = AbortSignal.abort()
    await expect(dream.execute({}, ctx({ signal }))).rejects.toMatchObject({
      code: 'MEMORY_DREAM_FAILED',
      message: 'Memory dream failed',
    })
  })
})
