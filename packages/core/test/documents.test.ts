import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createDocTools, envProvider } from '@breadai/core'
import type { BreadStore, ToolContext, ToolDefinition } from '@breadai/core'
import { store } from '@breadai/store-memory'

const ctx: ToolContext = {
  agentId: 'a',
  sessionId: 's',
  runId: 'r',
  credentials: envProvider(),
}

function docLoad(store: BreadStore): ToolDefinition {
  return createDocTools('a', store).find((t) => t.name === 'core_doc_load')!
}

describe('core_doc_load', () => {
  let testStore: BreadStore
  beforeEach(() => {
    testStore = store()
  })

  test('loads and ingests a document from a local file', async () => {
    const result = (await docLoad(testStore).execute(
      { source: join(import.meta.dir, 'fixtures', 'doc.txt') },
      ctx,
    )) as { id: string; length: number }
    expect(result.length).toBeGreaterThan(0)
    const read = await testStore.readDocument!({ agentId: 'a', id: result.id })
    expect(read?.content).toContain('hello from a local file')
  })

  describe('from a URL', () => {
    const realFetch = globalThis.fetch
    afterEach(() => {
      globalThis.fetch = realFetch
    })

    test('fetches the body and ingests it', async () => {
      globalThis.fetch = (async () => new Response('remote body', { status: 200 })) as typeof fetch
      const result = (await docLoad(testStore).execute(
        { source: 'https://example.com/doc' },
        ctx,
      )) as { id: string; length: number }
      const read = await testStore.readDocument!({ agentId: 'a', id: result.id })
      expect(read?.content).toBe('remote body')
    })

    test('throws when the remote responds non-ok', async () => {
      globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch
      await expect(
        docLoad(testStore).execute({ source: 'https://example.com/missing' }, ctx),
      ).rejects.toThrow('Failed to fetch')
    })
  })
})

function tool(store: BreadStore, name: string): ToolDefinition {
  return createDocTools('a', store).find((t) => t.name === name)!
}

describe('core_doc_ingest / core_doc_search / core_doc_read', () => {
  test('ingests a document then finds and reads it back', async () => {
    const testStore = store()
    const ingested = (await tool(testStore, 'core_doc_ingest').execute(
      { title: 'Cities', content: 'Rome is the capital of Italy' },
      ctx,
    )) as { id: string }
    expect(ingested.id).toBeTruthy()

    const found = (await tool(testStore, 'core_doc_search').execute({ query: 'Rome' }, ctx)) as unknown[]
    expect(found.length).toBeGreaterThanOrEqual(1)

    const read = (await tool(testStore, 'core_doc_read').execute({ id: ingested.id }, ctx)) as {
      content: string
    }
    expect(read.content).toContain('Rome')
  })

  test('core_doc_read returns a not-found marker for an unknown id', async () => {
    const testStore = store()
    const read = (await tool(testStore, 'core_doc_read').execute({ id: 'missing' }, ctx)) as {
      error?: string
    }
    expect(read.error).toBe('Document not found')
  })

  test('createDocTools throws when the store lacks document support', () => {
    expect(() => createDocTools('a', {} as BreadStore)).toThrow('document operations')
  })

  test('exposes only the deterministic document tools (extraction is a task)', () => {
    const names = createDocTools('a', store()).map((t) => t.name)
    expect(names).toEqual(['core_doc_ingest', 'core_doc_search', 'core_doc_read', 'core_doc_load'])
  })
})
