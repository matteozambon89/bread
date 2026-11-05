import type { RerankingModel } from 'ai'
import { BreadError } from '@breadai/core'

// The named export is the provider object: a function or a plain object.
// Call `.reranking(modelId)` on it. Do not invoke the provider function.
export function rerankingModelFrom(
  namespace: object,
  exportName: string,
  provider: string,
  pkg: string,
  modelId: string,
): RerankingModel {
  const loaded = (namespace as Record<string, unknown>)[exportName]
  const reranking =
    typeof loaded === 'function' || (typeof loaded === 'object' && loaded !== null)
      ? (loaded as { reranking?: unknown }).reranking
      : undefined
  if (typeof reranking !== 'function') {
    throw new BreadError(
      `Provider package ${pkg} has no "reranking" method on "${exportName}"`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  return (reranking as (id: string) => RerankingModel)(modelId)
}
