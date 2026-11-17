import { describe, expect, test } from 'bun:test'
import type { EmbeddingModel } from 'ai'
import { defineConfig, type EmbeddingRegistry } from '@breadai/core'
import { store } from '@breadai/store-postgres'

const url = 'postgres://127.0.0.1:1/bread'

function throwingModel(): EmbeddingModel {
  return {
    modelId: 'nomic-embed-text',
    provider: 'test.embedding',
    specificationVersion: 'v4',
    async doEmbed() {
      throw new Error('stop before sql')
    },
  }
}

const document = { agentId: 'memory', title: 'note', content: 'hello' }
const principal = { iss: 'https://idp.example', sub: 'ada' }
const memory = { agentId: 'memory', principal, content: 'hello' }

describe('postgres embed', () => {
  test('store() and defineConfig do not resolve a ref', () => {
    let calls = 0
    const embeddings: EmbeddingRegistry = {
      ollama: () => {
        calls += 1
        return throwingModel()
      },
    }
    const backend = store({ url, embed: { provider: 'ollama', model: 'nomic-embed-text' } })
    defineConfig({ entrypoints: ['memory'], store: backend, embeddings })
    expect(calls).toBe(0)
  })

  test('a function is called as-is on document and memory operations', async () => {
    let calls = 0
    let registryCalls = 0
    const backend = store({
      url,
      embed: async (text) => {
        calls += 1
        throw new Error(`stop before sql:${text}`)
      },
    })
    defineConfig({
      entrypoints: ['memory'],
      store: backend,
      embeddings: {
        ollama: () => {
          registryCalls += 1
          return throwingModel()
        },
      },
    })
    await expect(backend.ingestDocument?.(document)).rejects.toThrow('stop before sql:hello')
    await expect(backend.searchDocuments?.({ agentId: 'memory', query: 'q' })).rejects.toThrow(
      'stop before sql:q',
    )
    await expect(backend.addMemory?.(memory)).rejects.toThrow('stop before sql:hello')
    await expect(
      backend.searchMemories?.({ agentId: 'memory', principal, query: 'k' }),
    ).rejects.toThrow('stop before sql:k')
    expect(calls).toBe(4)
    expect(registryCalls).toBe(0)
  })

  test('a ref with no defineConfig binding throws EMBEDDINGS_NOT_BOUND before sql', async () => {
    const backend = store({ url, embed: { provider: 'ollama', model: 'nomic-embed-text' } })
    await expect(backend.ingestDocument?.(document)).rejects.toMatchObject({
      code: 'EMBEDDINGS_NOT_BOUND',
    })
    await expect(backend.searchDocuments?.({ agentId: 'memory', query: 'q' })).rejects.toMatchObject({
      code: 'EMBEDDINGS_NOT_BOUND',
    })
    await expect(backend.addMemory?.(memory)).rejects.toMatchObject({
      code: 'EMBEDDINGS_NOT_BOUND',
    })
    await expect(
      backend.searchMemories?.({ agentId: 'memory', principal, query: 'k' }),
    ).rejects.toMatchObject({
      code: 'EMBEDDINGS_NOT_BOUND',
    })
  })

  test('a ref uses the registry assigned after defineConfig, once per write', async () => {
    let calls = 0
    const backend = store({ url, embed: { provider: 'ollama', model: 'nomic-embed-text' } })
    const config = defineConfig({
      entrypoints: ['memory'],
      store: backend,
      embeddings: {
        other: () => {
          throw new Error('wrong provider')
        },
      },
    })
    await expect(backend.ingestDocument?.(document)).rejects.toMatchObject({
      code: 'UNKNOWN_EMBEDDING_PROVIDER',
    })
    const embeddings: EmbeddingRegistry = {
      ollama: (modelId) => {
        calls += 1
        expect(modelId).toBe('nomic-embed-text')
        return throwingModel()
      },
    }
    config.embeddings = embeddings
    await expect(backend.ingestDocument?.(document)).rejects.toThrow('stop before sql')
    await expect(backend.searchDocuments?.({ agentId: 'memory', query: 'q' })).rejects.toThrow(
      'stop before sql',
    )
    await expect(backend.addMemory?.(memory)).rejects.toThrow('stop before sql')
    await expect(
      backend.searchMemories?.({ agentId: 'memory', principal, query: 'k' }),
    ).rejects.toThrow('stop before sql')
    expect(calls).toBe(4)
    expect(config.embeddings).toBe(embeddings)
  })
})
