import { describe, expect, test } from 'bun:test'
import { defineConfig, rerankHits, resolveReranking } from '@breadai/core'
import type { RerankingRegistry } from '@breadai/core'

const reranking: RerankingRegistry = {
  cohere: (modelId) => `cohere:${modelId}`,
  voyage: async (modelId) => `voyage:${modelId}`,
}

describe('resolveReranking', () => {
  test('resolves a reranking model from config.reranking, not providers', async () => {
    const config = defineConfig({
      entrypoints: ['memory'],
      reranking,
    })
    expect(config.providers).toBeUndefined()
    expect(config.reranking).toBe(reranking)
    await expect(
      resolveReranking({ provider: 'cohere', model: 'rerank-v3.5' }, config.reranking),
    ).resolves.toBe('cohere:rerank-v3.5')
  })

  test('supports an async factory', async () => {
    await expect(
      resolveReranking({ provider: 'voyage', model: 'rerank-2.5' }, reranking),
    ).resolves.toBe('voyage:rerank-2.5')
  })

  test('throws RERANKING_NOT_CONFIGURED when no registry is passed', async () => {
    await expect(resolveReranking({ provider: 'cohere', model: 'rerank-v3.5' })).rejects.toMatchObject({
      code: 'RERANKING_NOT_CONFIGURED',
    })
  })

  test('throws UNKNOWN_RERANKING_PROVIDER naming the registered providers', async () => {
    const err = await resolveReranking({ provider: 'openai-compatible', model: 'x' }, reranking).catch(
      (error) => error,
    )
    expect(err.code).toBe('UNKNOWN_RERANKING_PROVIDER')
    expect(err.message).toContain('cohere')
    expect(err.message).toContain('voyage')
    expect(err.message).toContain('openai-compatible')
  })

  test('throws UNKNOWN_RERANKING_PROVIDER when the registry is empty', async () => {
    await expect(resolveReranking({ provider: 'cohere', model: 'x' }, {})).rejects.toMatchObject({
      code: 'UNKNOWN_RERANKING_PROVIDER',
    })
  })
})

function scoreModel(score: (text: string) => number) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'test',
    modelId: 'rerank',
    async doRerank(options: {
      documents: { type: 'text'; values: string[] } | { type: 'object'; values: unknown[] }
      topN?: number
    }) {
      if (options.documents.type !== 'text') throw new Error('expected text documents')
      const ranking = options.documents.values
        .map((value, index) => ({ index, relevanceScore: score(value) }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index)
      return { ranking: options.topN === undefined ? ranking : ranking.slice(0, options.topN) }
    },
  }
}

describe('rerankHits', () => {
  test('reorders by score and still applies limit', async () => {
    let modelId = ''
    const registry: RerankingRegistry = {
      cohere: (id) => {
        modelId = id
        return scoreModel((text) => (text === 'best' ? 3 : text === 'mid' ? 2 : 1))
      },
    }
    const hits = [
      { id: 'w', text: 'worst' },
      { id: 'b', text: 'best' },
      { id: 'm', text: 'mid' },
    ]
    const ordered = await rerankHits({
      query: 'q',
      hits,
      text: (hit) => hit.text,
      ref: { provider: 'cohere', model: 'rerank-v3.5' },
      registry,
      limit: 2,
    })
    expect(modelId).toBe('rerank-v3.5')
    expect(ordered.map((hit) => hit.id)).toEqual(['b', 'm'])
  })

  test('resolves the model even when there are no hits', async () => {
    await expect(
      rerankHits({
        query: 'q',
        hits: [],
        text: () => '',
        ref: { provider: 'cohere', model: 'x' },
        registry: undefined,
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: 'RERANKING_NOT_CONFIGURED' })
  })
})
