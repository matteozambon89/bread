import { rerank, type RerankingModel } from 'ai'
import { BreadError } from './types.js'

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

// Reorder `hits` by reranker score and cap at `limit`. Resolves the model even
// when there is nothing to score, so a missing registry fails the search.
export async function rerankHits<T>(input: {
  query: string
  hits: readonly T[]
  text: (hit: T) => string
  ref: RerankRef
  registry: RerankingRegistry | undefined
  limit: number
}): Promise<T[]> {
  const { query, hits, text, ref, registry, limit } = input
  const model = await resolveReranking(ref, registry)
  if (hits.length === 0 || limit <= 0) return []
  const { ranking } = await rerank({
    model,
    documents: hits.map((hit) => text(hit)),
    query,
    topN: limit,
  })
  const ordered: T[] = []
  for (const row of ranking) {
    const hit = hits[row.originalIndex]
    if (hit !== undefined) ordered.push(hit)
    if (ordered.length >= limit) break
  }
  return ordered
}
