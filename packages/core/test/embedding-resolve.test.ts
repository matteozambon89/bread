import { describe, expect, test } from 'bun:test'
import type { EmbeddingModel } from 'ai'
import { defineConfig, resolveEmbeddingModel, type EmbeddingRegistry } from '@breadai/core'

describe('resolveEmbeddingModel', () => {
  test('reads the live registry and does not call a factory while the config is defined', async () => {
    let calls = 0
    const first = { modelId: 'first' } as EmbeddingModel
    const second = { modelId: 'second' } as EmbeddingModel
    const embeddings: EmbeddingRegistry = {
      openai: (modelId) => {
        calls += 1
        expect(modelId).toBe('text-embedding-3-small')
        return first
      },
    }
    const config = defineConfig({ entrypoints: ['writer'], embeddings })
    expect(calls).toBe(0)

    expect(await resolveEmbeddingModel(config.embeddings, 'openai', 'text-embedding-3-small')).toBe(first)
    config.embeddings = {
      openai: () => second,
    }
    expect(await resolveEmbeddingModel(config.embeddings, 'openai', 'text-embedding-3-small')).toBe(second)
    await expect(resolveEmbeddingModel(config.embeddings, 'voyage', 'voyage-3')).rejects.toMatchObject({
      code: 'UNKNOWN_EMBEDDING_PROVIDER',
    })
    await expect(resolveEmbeddingModel(undefined, 'openai', 'text-embedding-3-small')).rejects.toMatchObject({
      code: 'UNKNOWN_EMBEDDING_PROVIDER',
    })
  })
})
