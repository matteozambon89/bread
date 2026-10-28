import { describe, expect, test } from 'bun:test'
import type { EmbeddingModel } from 'ai'
import { defineConfig, type EmbeddingRegistry } from '@breadai/core'

describe('BreadConfig.embeddings', () => {
  test('keeps an embedding registry separate from language-model providers', async () => {
    const model = { modelId: 'text-embedding-3-small' } as EmbeddingModel
    const embeddings: EmbeddingRegistry = {
      openai: (modelId) => {
        expect(modelId).toBe('text-embedding-3-small')
        return model
      },
    }
    const config = defineConfig({ entrypoints: ['memory'], embeddings })

    expect(config.embeddings).toBe(embeddings)
    expect(config.providers).toBeUndefined()
    expect(await config.embeddings?.openai?.('text-embedding-3-small')).toBe(model)
  })
})
