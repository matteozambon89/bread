import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { EmbeddingModel } from 'ai'
import postgres from 'postgres'
import { defineConfig, type EmbeddingRegistry, type BreadStore, type StoreEmbed } from '@breadai/core'
import { store } from '@breadai/store-postgres'
import { type PgliteHandle, withPglite } from '@breadai/test-utils'

const document = { agentId: 'memory', title: 'note', content: 'hello' }
const principal = { iss: 'https://idp.example', sub: 'ada' }
const memory = { agentId: 'memory', principal, content: 'hello' }

function model(width: number): EmbeddingModel {
  return {
    modelId: 'nomic-embed-text',
    provider: 'test.embedding',
    specificationVersion: 'v4',
    async doEmbed() {
      return { embeddings: [Array.from({ length: width }, () => 0.1)] }
    },
  }
}

async function settle(run: Promise<unknown>): Promise<unknown> {
  try {
    return await run
  } catch (err) {
    return err
  }
}

describe('embedding dimensions', () => {
  let pg: PgliteHandle | undefined
  let url = ''

  beforeAll(async () => {
    pg = await withPglite({ vector: true })
    url = pg.url
    const backend = store({ url, embed: async () => [0] })
    await backend.migrate?.()
    await backend.close?.()
  })

  afterEach(async () => {
    if (!url) return
    const admin = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await admin`DELETE FROM bread_documents`
      await admin`DELETE FROM bread_memories`
      await admin`DELETE FROM bread_embedding_widths`
    } finally {
      await admin.end({ timeout: 5 })
    }
  })

  afterAll(async () => {
    await pg?.close()
  })

  async function withBackend(embed: StoreEmbed, run: (backend: BreadStore) => Promise<void>) {
    const backend = store({ url, embed })
    try {
      await run(backend)
    } finally {
      await backend.close?.()
    }
  }

  test('ingest accepts the first length and rejects a different one before ::vector', async () => {
    await withBackend(async () => [1, 0, 0], async (backend) => {
      const first = await settle(backend.ingestDocument!(document))
      const again = await settle(backend.ingestDocument!(document))
      expect(first).toMatchObject({ title: 'note' })
      expect(again).toMatchObject({ title: 'note' })
    })

    await withBackend(async () => [1, 0], async (backend) => {
      const mismatch = await settle(backend.ingestDocument!(document))
      expect(mismatch).toMatchObject({
        code: 'EMBEDDING_DIMENSION',
        context: { relation: 'bread_documents', stored: 3, length: 2 },
      })
      const message = (mismatch as Error).message
      expect(message).toContain('3')
      expect(message).toContain('2')
      expect(message).not.toContain('provider')
    })
  })

  test('document search rejects a length that differs from stored document vectors', async () => {
    await withBackend(async () => [1, 0, 0], async (backend) => {
      const stored = await settle(backend.ingestDocument!(document))
      expect(stored).toMatchObject({ title: 'note' })
    })
    await withBackend(async () => [9], async (backend) => {
      const mismatch = await settle(backend.searchDocuments!({ agentId: 'memory', query: 'q' }))
      expect(mismatch).toMatchObject({
        code: 'EMBEDDING_DIMENSION',
        context: { relation: 'bread_documents', stored: 3, length: 1 },
      })
      expect((mismatch as Error).message).toContain('3')
      expect((mismatch as Error).message).toContain('1')
    })
  })

  test('memory write accepts the first length and rejects a different one', async () => {
    await withBackend(async () => [1, 0, 0, 0], async (backend) => {
      const first = await settle(backend.addMemory!(memory))
      expect(first).toMatchObject({ content: 'hello' })
    })
    await withBackend(async () => [1, 0], async (backend) => {
      const mismatch = await settle(backend.addMemory!(memory))
      expect(mismatch).toMatchObject({
        code: 'EMBEDDING_DIMENSION',
        context: { relation: 'bread_memories', stored: 4, length: 2 },
      })
      expect((mismatch as Error).message).toContain('4')
      expect((mismatch as Error).message).toContain('2')
    })
  })

  test('memory search rejects a length that differs from stored memory vectors', async () => {
    await withBackend(async () => [1, 0, 0, 0], async (backend) => {
      const stored = await settle(backend.addMemory!(memory))
      expect(stored).toMatchObject({ content: 'hello' })
    })
    await withBackend(async () => [7, 7], async (backend) => {
      const mismatch = await settle(
        backend.searchMemories!({ agentId: 'memory', principal, query: 'k' }),
      )
      expect(mismatch).toMatchObject({
        code: 'EMBEDDING_DIMENSION',
        context: { relation: 'bread_memories', stored: 4, length: 2 },
      })
      expect((mismatch as Error).message).toContain('4')
      expect((mismatch as Error).message).toContain('2')
    })
  })

  test('search and list of an empty relation do not lock a width', async () => {
    await withBackend(async () => [1, 0], async (backend) => {
      const search = await settle(backend.searchDocuments!({ agentId: 'memory', query: 'q' }))
      const found = await settle(backend.searchMemories!({ agentId: 'memory', principal, query: 'k' }))
      const listed = await settle(backend.listMemories!({ agentId: 'memory', principal }))
      expect(search).toEqual([])
      expect(found).toEqual([])
      expect(listed).toEqual([])
    })
    await withBackend(async () => [1, 0, 0, 0], async (backend) => {
      const ingested = await settle(backend.ingestDocument!(document))
      const written = await settle(backend.addMemory!(memory))
      expect(ingested).toMatchObject({ title: 'note' })
      expect(written).toMatchObject({ content: 'hello' })
    })
  })

  test('a document width does not constrain memories', async () => {
    await withBackend(async () => [1, 0, 0], async (backend) => {
      const ingested = await settle(backend.ingestDocument!(document))
      expect(ingested).toMatchObject({ title: 'note' })
    })
    await withBackend(async () => [1, 0], async (backend) => {
      const written = await settle(backend.addMemory!(memory))
      expect(written).toMatchObject({ content: 'hello' })
    })
  })

  test('a ref names the provider and model on every vector operation', async () => {
    await withBackend(async () => [1, 0, 0], async (backend) => {
      const ingested = await settle(backend.ingestDocument!(document))
      const written = await settle(backend.addMemory!(memory))
      expect(ingested).toMatchObject({ title: 'note' })
      expect(written).toMatchObject({ content: 'hello' })
    })

    const backend = store({
      url,
      embed: { provider: 'ollama', model: 'nomic-embed-text' },
    })
    const embeddings: EmbeddingRegistry = {
      ollama: () => model(2),
    }
    defineConfig({ entrypoints: ['memory'], store: backend, embeddings })
    try {
      const failures = [
        await settle(backend.ingestDocument!(document)),
        await settle(backend.searchDocuments!({ agentId: 'memory', query: 'q' })),
        await settle(backend.addMemory!(memory)),
        await settle(backend.searchMemories!({ agentId: 'memory', principal, query: 'k' })),
      ]
      for (const failure of failures) {
        expect(failure).toMatchObject({
          code: 'EMBEDDING_DIMENSION',
          context: { stored: 3, length: 2, provider: 'ollama', model: 'nomic-embed-text' },
        })
        const message = (failure as Error).message
        expect(message).toContain('3')
        expect(message).toContain('2')
        expect(message).toContain('ollama')
        expect(message).toContain('nomic-embed-text')
      }
    } finally {
      await backend.close?.()
    }
  })
})
