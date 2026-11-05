import { rerank, type RerankingModel } from 'ai'
import { BreadError } from './types.js'

// Voyage and Bedrock reject a rerank call with more documents than this.
export const RERANK_DOCUMENT_CAP = 1000

type RerankCall = Parameters<typeof rerank>[0]

// A named reranking registry. Keys are provider names; values return an AI SDK
// RerankingModel. This is not a ProviderRegistry — that returns a LanguageModel.
// A factory may resolve asynchronously (see @breadai/provider-reranking).
export type RerankingRegistry = Record<
  string,
  (modelId: string) => RerankingModel | Promise<RerankingModel>
>

export interface RerankRef {
  provider: string
  model: string
}

export async function resolveReranking(
  ref: RerankRef,
  registry?: RerankingRegistry,
): Promise<RerankingModel> {
  if (registry === undefined) {
    throw new BreadError(
      'No reranking registry is configured. Set `reranking` in bread.config.ts ' +
        '(see @breadai/provider-reranking).',
      'RERANKING_NOT_CONFIGURED',
    )
  }
  const factory = registry[ref.provider]
  if (!factory) {
    const known = Object.keys(registry)
    throw new BreadError(
      `Unknown reranking provider: "${ref.provider}". ` +
        (known.length
          ? `Registered: ${known.join(', ')}. `
          : 'No reranking providers are registered. ') +
        'Set `reranking` in bread.config.ts (see @breadai/provider-reranking).',
      'UNKNOWN_RERANKING_PROVIDER',
      { provider: ref.provider, registered: known },
    )
  }
  return factory(ref.model)
}

// bread.start() hands config.reranking to a store that implements this.
// SQLite and memory do not, so they stay keyword-only.
export function bindStoreReranking(
  store: object,
  registry: RerankingRegistry | undefined,
): void {
  const candidate = (store as { bindReranking?: unknown }).bindReranking
  if (typeof candidate !== 'function') return
  candidate.call(store, registry)
}

// Reorder `hits` by reranker score and cap at `limit`. The model is resolved
// even when there is nothing to score, so a missing registry fails the search.
// Blank rows are omitted. A provider rejection keeps retrieval order.
export async function rerankHits<T>(input: {
  query: string
  hits: readonly T[]
  text: (hit: T) => string
  ref: RerankRef
  registry: RerankingRegistry | undefined
  limit: number
  providerOptions?: RerankCall['providerOptions']
  abortSignal?: AbortSignal
}): Promise<T[]> {
  const { query, hits, text, ref, registry, limit, providerOptions, abortSignal } = input
  const model = await resolveReranking(ref, registry)
  if (hits.length === 0 || limit <= 0) return []
  const page = Math.floor(limit)
  if (page <= 0) return []
  const candidates = hits
    .map((hit, index) => ({ hit, index, text: text(hit).trim() }))
    .filter((row) => row.text.length > 0)
  if (candidates.length === 0) return hits.slice(0, page)
  try {
    return await rankCandidates({ model, query, candidates, page, providerOptions, abortSignal })
  } catch (error) {
    if (error instanceof BreadError) throw error
    return candidates.slice(0, page).map((row) => row.hit)
  }
}

async function rankCandidates<T>(input: {
  model: RerankingModel
  query: string
  candidates: ReadonlyArray<{ hit: T; index: number; text: string }>
  page: number
  providerOptions: RerankCall['providerOptions']
  abortSignal: AbortSignal | undefined
}): Promise<T[]> {
  const { model, query, candidates, page, providerOptions, abortSignal } = input
  const multi = candidates.length > RERANK_DOCUMENT_CAP
  const ranked: { hit: T; score: number; index: number }[] = []
  for (let start = 0; start < candidates.length; start += RERANK_DOCUMENT_CAP) {
    const batch = candidates.slice(start, start + RERANK_DOCUMENT_CAP)
    const topN = multi ? batch.length : Math.min(page, batch.length)
    const call: RerankCall = {
      model,
      documents: batch.map((row) => row.text),
      query,
      topN,
    }
    if (abortSignal) call.abortSignal = abortSignal
    if (providerOptions) call.providerOptions = providerOptions
    const { ranking } = await rerank(call)
    for (const row of ranking) {
      const candidate = batch[row.originalIndex]
      if (!candidate) continue
      ranked.push({ hit: candidate.hit, score: row.score, index: candidate.index })
    }
  }
  if (!multi) return ranked.slice(0, page).map((row) => row.hit)
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  return ranked.slice(0, page).map((row) => row.hit)
}
