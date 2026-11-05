import assert from 'node:assert/strict'
import { afterAll, afterEach, beforeAll, test } from 'bun:test'
import { BreadError, createBread, RERANK_DOCUMENT_CAP, type RerankingRegistry } from '@breadai/core'
import postgres from 'postgres'
import { store } from '@breadai/store-postgres'
import { type PgliteHandle, withPglite } from '@breadai/test-utils'

// Mirrors stores/postgres/src/rerank-query.ts. A larger SQL read fails these tests.
const RERANK_WINDOW_MULTIPLE = 4

function candidatePage(limit: number): number {
  return Math.min(limit * RERANK_WINDOW_MULTIPLE, RERANK_DOCUMENT_CAP)
}

type Seen = {
  model?: string
  batches?: string[][]
  topN?: number
  count?: number
}

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

function scoreModel(score: (text: string) => number, seen?: Seen) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'test',
    modelId: 'rerank',
    async doRerank(options: {
      documents: { type: 'text'; values: string[] } | { type: 'object'; values: unknown[] }
      topN?: number
    }) {
      if (options.documents.type !== 'text') throw new Error('expected text documents')
      const values = options.documents.values
      if (seen) {
        seen.batches?.push(values)
        seen.topN = options.topN
        seen.count = values.length
      }
      // Bedrock rejects numberOfResults greater than the number of sources.
      if (options.topN !== undefined && options.topN > values.length) {
        throw new Error('numberOfResults greater than sources')
      }
      if (values.some((value) => value.trim() === '')) throw new Error('empty document')
      const ranking = values
        .map((value, index) => ({ index, relevanceScore: score(value) }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index)
      return { ranking: options.topN === undefined ? ranking : ranking.slice(0, options.topN) }
    },
  }
}

function registry(seen: Seen, score?: (text: string) => number): RerankingRegistry {
  return {
    cohere: (modelId) => {
      seen.model = modelId
      return scoreModel(
        score ?? ((text) => (text.startsWith('best') ? 3 : text.startsWith('mid') ? 2 : 1)),
        seen,
      )
    },
  }
}

async function withStarted(
  reranking: RerankingRegistry | undefined,
  fn: (s: ReturnType<typeof store>) => Promise<void>,
  embed?: (text: string) => Promise<number[]>,
) {
  const s = store({
    url,
    rerank: { provider: 'cohere', model: 'rerank-v3.5' },
    ...(embed ? { embed } : {}),
  })
  const bread = createBread({
    entrypoints: [],
    store: s,
    ...(reranking ? { reranking } : {}),
  })
  try {
    await bread.start()
    await fn(s)
  } finally {
    await bread.stop()
  }
}

test('searchDocuments reranks on content and still applies limit', async () => {
  const seen: Seen = {}
  await withStarted(registry(seen, (text) => (text.includes('best apples') ? 3 : text.includes('mid apples') ? 2 : 1)), async (s) => {
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
  const seen: Seen = {}
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

test('fewer hits than the default limit still rerank', async () => {
  const seen: Seen = {}
  await withStarted(registry(seen), async (s) => {
    await s.ingestDocument?.({ agentId: 'a', title: 'Notes', content: 'best apples' })
    const hits = await s.searchDocuments?.({ agentId: 'a', query: 'apples' })
    assert.equal(hits?.length, 1)
    assert.ok(seen.topN !== undefined && seen.count !== undefined && seen.topN <= seen.count)
  })
})

test('keyword rerank keeps a title match and does not send empty content', async () => {
  const seen: Seen = { batches: [] }
  const score = (text: string) =>
    text.includes('best apples') ? 3 : text.includes('mid apples') ? 2 : 1
  await withStarted(registry(seen, score), async (s) => {
    await s.ingestDocument?.({ agentId: 'a', title: 'best apples', content: '' })
    await s.ingestDocument?.({ agentId: 'a', title: 'note', content: 'mid apples' })
    await s.ingestDocument?.({ agentId: 'a', title: 'note-2', content: 'low apples' })
    const hits = await s.searchDocuments?.({ agentId: 'a', query: 'apples', limit: 2 })
    assert.deepEqual(
      hits?.map((hit) => hit.title),
      ['best apples', 'note'],
    )
    const sent = seen.batches?.flat() ?? []
    assert.ok(sent.some((text) => text.includes('best apples')))
    assert.ok(sent.every((text) => text.trim() !== ''))
  })
})

test('keyword rerank escapes LIKE wildcards', async () => {
  const seen: Seen = {}
  await withStarted(registry(seen), async (s) => {
    await s.ingestDocument?.({ agentId: 'a', title: '100% done', content: 'notes' })
    await s.ingestDocument?.({ agentId: 'a', title: 'plain', content: 'other words' })
    await s.ingestDocument?.({ agentId: 'a', title: 'a_b', content: 'underscore' })
    await s.ingestDocument?.({ agentId: 'a', title: 'axb', content: 'letters' })
    await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: '100% done', data: {} })
    await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: 'plain fact', data: {} })
    const percent = await s.searchDocuments?.({ agentId: 'a', query: '%', limit: 5 })
    assert.deepEqual(
      percent?.map((hit) => hit.title),
      ['100% done'],
    )
    const underscore = await s.searchDocuments?.({ agentId: 'a', query: '_', limit: 5 })
    assert.deepEqual(
      underscore?.map((hit) => hit.title),
      ['a_b'],
    )
    const labels = await s.queryKnowledge?.({ agentId: 'a', query: '%', limit: 5 })
    assert.deepEqual(
      labels?.map((hit) => hit.label),
      ['100% done'],
    )
  })
  const plain = store({ url })
  await plain.migrate?.()
  try {
    await plain.ingestDocument?.({ agentId: 'b', title: '100% done', content: 'notes' })
    await plain.ingestDocument?.({ agentId: 'b', title: 'plain', content: 'other words' })
    const hits = await plain.searchDocuments?.({ agentId: 'b', query: '%', limit: 5 })
    assert.deepEqual(
      hits?.map((hit) => hit.title),
      ['100% done'],
    )
  } finally {
    await plain.close?.()
  }
})

test('keyword rerank uses a bounded page of the newest matches', async () => {
  const limit = 2
  const page = candidatePage(limit)
  const seen: Seen = { batches: [] }
  const score = (text: string) => {
    if (text.includes('old-best')) return 100
    const match = text.match(/rank-(\d+)/)
    return match ? Number(match[1]) : 0
  }
  const contents = [
    ...Array.from({ length: 3 }, () => 'old-best hit'),
    ...Array.from({ length: page }, (_, index) => `rank-${index + 3} hit`),
  ]
  await withStarted(registry(seen, score), async (s) => {
    for (const content of contents) {
      await s.ingestDocument?.({ agentId: 'a', title: content, content })
      await delay(10)
      await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: content, data: {} })
      await delay(10)
    }
    const docs = await s.searchDocuments?.({ agentId: 'a', query: 'hit', limit })
    const knowledge = await s.queryKnowledge?.({ agentId: 'a', query: 'hit', limit })
    assert.equal(seen.batches?.length, 2)
    for (const batch of seen.batches ?? []) {
      assert.equal(batch.length, page)
      assert.ok(batch.every((text) => !text.includes('old-best')))
    }
    assert.deepEqual(
      docs?.map((hit) => hit.title),
      [`rank-${page + 2} hit`, `rank-${page + 1} hit`],
    )
    assert.deepEqual(
      knowledge?.map((hit) => hit.label),
      [`rank-${page + 2} hit`, `rank-${page + 1} hit`],
    )
  })
})

test('rerank stops at the provider document cap', async () => {
  const limit = 300
  const page = candidatePage(limit)
  assert.equal(page, RERANK_DOCUMENT_CAP)
  const count = page + 5
  const admin = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await admin`
      INSERT INTO bread_documents (id, agent_id, title, content, source, created_at)
      SELECT i::text, 'cap', 'doc-' || i, 'apples ' || i, NULL, i
      FROM generate_series(1, ${count}) AS i`
    await admin`
      INSERT INTO bread_kg_nodes (id, agent_id, session_id, label, data, created_at)
      SELECT i::text, 'cap', 's', 'apples ' || i, '{}'::jsonb, i
      FROM generate_series(1, ${count}) AS i`
  } finally {
    await admin.end({ timeout: 5 })
  }
  const seen: Seen = { batches: [] }
  await withStarted(registry(seen, () => 1), async (s) => {
    const docs = await s.searchDocuments?.({ agentId: 'cap', query: 'apples', limit })
    const knowledge = await s.queryKnowledge?.({ agentId: 'cap', query: 'apples', limit })
    assert.equal(seen.batches?.length, 2)
    for (const batch of seen.batches ?? []) assert.equal(batch.length, page)
    assert.equal(docs?.length, limit)
    assert.equal(knowledge?.length, limit)
  })
})

test('embed and rerank reorder a vector-ordered candidate page', async () => {
  const limit = 2
  const page = candidatePage(limit)
  const seen: Seen = { batches: [] }
  const embed = async (text: string) => {
    if (text === 'query') return [1, 0]
    const near = /^near-(\d+)$/.exec(text)
    if (near) return [1, Number(near[1]) * 0.01]
    return [0, 1]
  }
  const score = (text: string) => {
    if (text.includes('far-best')) return 1000
    const match = text.match(/near-(\d+)/)
    return match ? Number(match[1]) : 0
  }
  await withStarted(
    registry(seen, score),
    async (s) => {
      for (let index = 0; index < page; index += 1) {
        const token = `near-${index}`
        await s.ingestDocument?.({ agentId: 'a', title: token, content: token })
        await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: token, data: { index } })
      }
      for (let index = 0; index < 3; index += 1) {
        await s.ingestDocument?.({ agentId: 'a', title: 'far-best', content: 'far-best' })
        await s.addKnowledgeNode?.({
          agentId: 'a',
          sessionId: 's',
          label: 'far-best',
          data: { index },
        })
      }
      const docs = await s.searchDocuments?.({ agentId: 'a', query: 'query', limit })
      const knowledge = await s.queryKnowledge?.({ agentId: 'a', query: 'query', limit })
      assert.equal(seen.batches?.length, 2)
      for (const batch of seen.batches ?? []) {
        assert.equal(batch.length, page)
        assert.ok(batch.every((text) => !text.includes('far-best')))
      }
      assert.deepEqual(
        docs?.map((hit) => hit.title),
        [`near-${page - 1}`, `near-${page - 2}`],
      )
      assert.deepEqual(
        knowledge?.map((hit) => hit.label),
        [`near-${page - 1}`, `near-${page - 2}`],
      )
      assert.deepEqual(knowledge?.[0]?.data, { index: page - 1 })
    },
    embed,
  )
})

test('an unset registry fails before the query is embedded', async () => {
  let embeds = 0
  const embed = async () => {
    embeds += 1
    return [1, 0]
  }
  await withStarted(
    undefined,
    async (s) => {
      await s.ingestDocument?.({ agentId: 'a', title: 'Notes', content: 'apples' })
      await s.addKnowledgeNode?.({ agentId: 'a', sessionId: 's', label: 'apples', data: {} })
      const afterWrite = embeds
      await assert.rejects(
        () => s.searchDocuments?.({ agentId: 'a', query: 'apples' }),
        (err: unknown) => err instanceof BreadError && err.code === 'RERANKING_NOT_CONFIGURED',
      )
      await assert.rejects(
        () => s.queryKnowledge?.({ agentId: 'a', query: 'apples' }),
        (err: unknown) => err instanceof BreadError && err.code === 'RERANKING_NOT_CONFIGURED',
      )
      assert.equal(embeds, afterWrite)
    },
    embed,
  )
})

test('bindReranking(undefined) clears a registry bound earlier', async () => {
  const seen: Seen = {}
  const s = store({ url, rerank: { provider: 'cohere', model: 'rerank-v3.5' } })
  await s.migrate?.()
  s.bindReranking(registry(seen))
  s.bindReranking(undefined)
  try {
    await s.ingestDocument?.({ agentId: 'a', title: 'Notes', content: 'apples' })
    await assert.rejects(
      () => s.searchDocuments?.({ agentId: 'a', query: 'apples' }),
      (err: unknown) => err instanceof BreadError && err.code === 'RERANKING_NOT_CONFIGURED',
    )
    await assert.rejects(
      () => s.queryKnowledge?.({ agentId: 'a', query: 'apples' }),
      (err: unknown) => err instanceof BreadError && err.code === 'RERANKING_NOT_CONFIGURED',
    )
  } finally {
    await s.close?.()
  }
})
