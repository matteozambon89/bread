import assert from 'node:assert/strict'
import { afterAll, afterEach, beforeAll, test } from 'bun:test'
import { BreadError, createBread, type RerankingRegistry } from '@breadai/core'
import { store } from '@breadai/store-postgres'
import { type PgliteHandle, withPglite } from '@breadai/test-utils'

const realUrl = process.env.BREAD_TEST_DATABASE_URL

let pg: PgliteHandle | undefined
let url: string

beforeAll(async () => {
  url = realUrl ?? (pg = await withPglite()).url
  const s = store({ url })
  await s.migrate?.()
  await s.close?.()
})

afterEach(async () => {
  if (pg) await pg.truncate()
})

afterAll(async () => {
  await pg?.close()
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

function registry(seen: { model?: string }): RerankingRegistry {
  return {
    cohere: (modelId) => {
      seen.model = modelId
      return scoreModel((text) => (text.startsWith('best') ? 3 : text.startsWith('mid') ? 2 : 1))
    },
  }
}

async function withStarted(
  reranking: RerankingRegistry | undefined,
  fn: (s: ReturnType<typeof store>) => Promise<void>,
) {
  const s = store({ url, rerank: { provider: 'cohere', model: 'rerank-v3.5' } })
  const bread = createBread({
    entrypoints: [],
    store: s,
    ...(reranking ? { reranking } : {}),
  })
  await bread.start()
  try {
    await fn(s)
  } finally {
    await bread.stop()
  }
}

test('searchDocuments reranks on content and still applies limit', async () => {
  const seen: { model?: string } = {}
  await withStarted(registry(seen), async (s) => {
    await s.ingestDocument?.({
      agentId: 'a',
      title: 'best-title',
      content: 'worst apples',
      source: 'worst.md',
    })
    await s.ingestDocument?.({
      agentId: 'a',
      title: 'worst-title',
      content: 'best apples',
      source: 'best.md',
    })
    await s.ingestDocument?.({
      agentId: 'a',
      title: 'mid-title',
      content: 'mid apples',
      source: 'mid.md',
    })
    const hits = await s.searchDocuments?.({ agentId: 'a', query: 'apples', limit: 2 })
    assert.equal(seen.model, 'rerank-v3.5')
    assert.deepEqual(
      hits?.map((hit) => hit.title),
      ['worst-title', 'mid-title'],
    )
    assert.equal(hits?.[0]?.source, 'best.md')
    assert.equal('content' in (hits?.[0] ?? {}), false)
  })
})

test('queryKnowledge reranks on label ahead of newest-first order', async () => {
  const seen: { model?: string } = {}
  await withStarted(registry(seen), async (s) => {
    await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: 'best fact', data: { n: 1 } })
    await delay(5)
    await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: 'mid fact', data: { n: 2 } })
    await delay(5)
    await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: 'worst fact', data: { n: 3 } })
    const hits = await s.queryKnowledge?.({ agentId: 'a', query: 'fact', limit: 2 })
    assert.deepEqual(
      hits?.map((hit) => hit.label),
      ['best fact', 'mid fact'],
    )
    assert.deepEqual(hits?.[0]?.data, { n: 1 })
  })
})

test('queryKnowledge without a rerank ref stays newest-first', async () => {
  const s = store({ url })
  await s.migrate?.()
  try {
    await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: 'best fact', data: {} })
    await delay(5)
    await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: 'worst fact', data: {} })
    const hits = await s.queryKnowledge?.({ agentId: 'a', query: 'fact', limit: 2 })
    assert.deepEqual(
      hits?.map((hit) => hit.label),
      ['worst fact', 'best fact'],
    )
  } finally {
    await s.close?.()
  }
})

test('search with a rerank ref and no registry throws RERANKING_NOT_CONFIGURED', async () => {
  await withStarted(undefined, async (s) => {
    await s.ingestDocument?.({ agentId: 'a', title: 'Notes', content: 'apples' })
    await assert.rejects(
      () => s.searchDocuments?.({ agentId: 'a', query: 'apples' }),
      (err: unknown) => err instanceof BreadError && err.code === 'RERANKING_NOT_CONFIGURED',
    )
  })
})
