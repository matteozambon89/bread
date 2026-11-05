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

  test('does not ask for more results than there are documents', async () => {
    let topN: number | undefined
    let count = 0
    const registry: RerankingRegistry = {
      cohere: () => ({
        specificationVersion: 'v4' as const,
        provider: 'test',
        modelId: 'rerank',
        async doRerank(options: {
          documents: { type: 'text'; values: string[] } | { type: 'object'; values: unknown[] }
          topN?: number
        }) {
          if (options.documents.type !== 'text') throw new Error('expected text documents')
          count = options.documents.values.length
          topN = options.topN
          if (options.topN !== undefined && options.topN > count) {
            throw new Error('numberOfResults greater than sources')
          }
          const ranking = options.documents.values
            .map((value, index) => ({ index, relevanceScore: value === 'best' ? 2 : 1 }))
            .sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index)
          return { ranking: options.topN === undefined ? ranking : ranking.slice(0, options.topN) }
        },
      }),
    }
    const ordered = await rerankHits({
      query: 'q',
      hits: [
        { id: 'm', text: 'mid' },
        { id: 'b', text: 'best' },
      ],
      text: (hit) => hit.text,
      ref: { provider: 'cohere', model: 'rerank-v3.5' },
      registry,
      limit: 5,
    })
    expect(topN).toBeLessThanOrEqual(count)
    expect(count).toBe(2)
    expect(ordered.map((hit) => hit.id)).toEqual(['b', 'm'])
  })

  test('does not send blank text to the provider', async () => {
    let seen: string[] = []
    const registry: RerankingRegistry = {
      cohere: () => ({
        specificationVersion: 'v4' as const,
        provider: 'test',
        modelId: 'rerank',
        async doRerank(options: {
          documents: { type: 'text'; values: string[] } | { type: 'object'; values: unknown[] }
        }) {
          if (options.documents.type !== 'text') throw new Error('expected text documents')
          seen = options.documents.values
          if (seen.some((value) => value.trim() === '')) throw new Error('empty document')
          return {
            ranking: seen
              .map((value, index) => ({
                index,
                relevanceScore: value === 'best' ? 2 : 1,
              }))
              .sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index),
          }
        },
      }),
    }
    const ordered = await rerankHits({
      query: 'q',
      hits: [
        { id: 'blank', text: '  ' },
        { id: 'm', text: 'mid' },
        { id: 'b', text: 'best' },
      ],
      text: (hit) => hit.text,
      ref: { provider: 'cohere', model: 'x' },
      registry,
      limit: 2,
    })
    expect(seen).toEqual(['mid', 'best'])
    expect(ordered.map((hit) => hit.id)).toEqual(['b', 'm'])
  })

  test('keeps retrieval order when every candidate text is blank', async () => {
    let calls = 0
    const registry: RerankingRegistry = {
      cohere: () => ({
        specificationVersion: 'v4' as const,
        provider: 'test',
        modelId: 'rerank',
        async doRerank() {
          calls += 1
          throw new Error('empty document')
        },
      }),
    }
    const ordered = await rerankHits({
      query: 'q',
      hits: [
        { id: 'a', text: '' },
        { id: 'b', text: ' ' },
      ],
      text: (hit) => hit.text,
      ref: { provider: 'cohere', model: 'x' },
      registry,
      limit: 1,
    })
    expect(calls).toBe(0)
    expect(ordered.map((hit) => hit.id)).toEqual(['a'])
  })

  test('falls back to retrieval order when the provider rejects the batch', async () => {
    const registry: RerankingRegistry = {
      cohere: () => ({
        specificationVersion: 'v4' as const,
        provider: 'test',
        modelId: 'rerank',
        async doRerank() {
          throw new Error('provider rejected the body')
        },
      }),
    }
    const ordered = await rerankHits({
      query: 'q',
      hits: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      text: () => 'body',
      ref: { provider: 'cohere', model: 'x' },
      registry,
      limit: 2,
    })
    expect(ordered.map((hit) => hit.id)).toEqual(['a', 'b'])
  })

  test('forwards providerOptions and abortSignal', async () => {
    const abort = new AbortController()
    let seenOptions: unknown
    let seenSignal: AbortSignal | undefined
    const registry: RerankingRegistry = {
      cohere: () => ({
        specificationVersion: 'v4' as const,
        provider: 'test',
        modelId: 'rerank',
        async doRerank(options: {
          documents: { type: 'text'; values: string[] } | { type: 'object'; values: unknown[] }
          providerOptions?: unknown
          abortSignal?: AbortSignal
        }) {
          seenOptions = options.providerOptions
          seenSignal = options.abortSignal
          return { ranking: [{ index: 0, relevanceScore: 1 }] }
        },
      }),
    }
    await rerankHits({
      query: 'q',
      hits: [{ id: 'a' }],
      text: () => 'body',
      ref: { provider: 'cohere', model: 'x' },
      registry,
      limit: 1,
      providerOptions: { cohere: { maxTokensPerDoc: 4096 } },
      abortSignal: abort.signal,
    })
    expect(seenOptions).toEqual({ cohere: { maxTokensPerDoc: 4096 } })
    expect(seenSignal).toBe(abort.signal)
  })

  test('reranks above the provider document cap in batches', async () => {
    const cap = 1000
    const calls: number[] = []
    const registry: RerankingRegistry = {
      cohere: () => ({
        specificationVersion: 'v4' as const,
        provider: 'test',
        modelId: 'rerank',
        async doRerank(options: {
          documents: { type: 'text'; values: string[] } | { type: 'object'; values: unknown[] }
          topN?: number
        }) {
          if (options.documents.type !== 'text') throw new Error('expected text documents')
          const values = options.documents.values
          calls.push(values.length)
          if (values.length > cap) throw new Error('too many documents')
          if (options.topN !== undefined && options.topN > values.length) {
            throw new Error('numberOfResults greater than sources')
          }
          const ranking = values.map((value, index) => ({
            index,
            relevanceScore: value === 'best' ? 2 : 1,
          }))
          const topN = options.topN ?? values.length
          return {
            ranking: ranking.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, topN),
          }
        },
      }),
    }
    const hits = Array.from({ length: cap + 1 }, (_, index) => ({
      id: String(index),
      text: index === cap ? 'best' : 'other',
    }))
    const ordered = await rerankHits({
      query: 'q',
      hits,
      text: (hit) => hit.text,
      ref: { provider: 'cohere', model: 'x' },
      registry,
      limit: 1,
    })
    expect(calls.every((count) => count <= cap)).toBe(true)
    expect(calls.reduce((sum, count) => sum + count, 0)).toBe(cap + 1)
    expect(ordered.map((hit) => hit.id)).toEqual([String(cap)])
  })
})
