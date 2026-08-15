import { describe, expect, test } from 'bun:test'
import { buildKgContext, createKgTools, envProvider } from '@breadai/core'
import type { BreadStore, ToolContext, ToolDefinition } from '@breadai/core'
import { store } from '@breadai/store-memory'

const ctx: ToolContext = {
  agentId: 'a',
  sessionId: 's',
  runId: 'r',
  credentials: envProvider(),
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  return tools.find((t) => t.name === name)!
}

describe('createKgTools', () => {
  test('throws when the store has no knowledge-graph support', () => {
    expect(() => createKgTools('a', {} as BreadStore)).toThrow('knowledge-graph')
  })

  test('core_kg_store adds a node that core_kg_query can find', async () => {
    const testStore = store()
    const tools = createKgTools('a', testStore)
    const stored = (await tool(tools, 'core_kg_store').execute(
      { label: 'Ada Lovelace', data: { field: 'computing' } },
      ctx,
    )) as { id: string; label: string }
    expect(stored.id).toBeTruthy()

    const found = (await tool(tools, 'core_kg_query').execute({ query: 'Ada' }, ctx)) as unknown[]
    expect(found.length).toBeGreaterThanOrEqual(1)
  })

  test('core_kg_forget removes a node', async () => {
    const testStore = store()
    const tools = createKgTools('a', testStore)
    const stored = (await tool(tools, 'core_kg_store').execute({ label: 'Temp' }, ctx)) as { id: string }
    const result = (await tool(tools, 'core_kg_forget').execute({ id: stored.id }, ctx)) as {
      deleted: boolean
    }
    expect(result.deleted).toBe(true)
  })
})

describe('buildKgContext', () => {
  test('returns an empty string when there is no context', async () => {
    const testStore = store()
    expect(await buildKgContext(testStore, 'a', 's')).toBe('')
  })

  test('formats stored nodes into a prompt block', async () => {
    const testStore = store()
    const tools = createKgTools('a', testStore)
    await tool(tools, 'core_kg_store').execute({ label: 'Rome', data: { country: 'Italy' } }, ctx)

    const block = await buildKgContext(testStore, 'a', 's')
    expect(block).toContain('## Knowledge Graph Context')
    expect(block).toContain('Rome')
    expect(block).toContain('country: Italy')
  })
})
