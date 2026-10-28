import { BreadError, type RerankingRegistry } from '@breadai/core'
import { rerankingModelFrom } from './load.js'

interface CatalogEntry {
  pkg: string
  export: string
}

// Optional peers, imported on first use. No openai-compatible key: the AI SDK
// has no reranking factory for it. `bedrock` is the amazonBedrock alias, the
// same export @breadai/provider-llm loads.
const ENTRIES: Record<string, CatalogEntry> = {
  cohere: { pkg: '@ai-sdk/cohere', export: 'cohere' },
  'amazon-bedrock': { pkg: '@ai-sdk/amazon-bedrock', export: 'bedrock' },
  togetherai: { pkg: '@ai-sdk/togetherai', export: 'togetherai' },
  voyage: { pkg: '@ai-sdk/voyage', export: 'voyage' },
}

function missingProvider(provider: string, pkg: string): never {
  throw new BreadError(`Provider ${pkg} is not installed. Run: bun add ${pkg}`, 'MISSING_PROVIDER', {
    provider,
  })
}

async function resolveEntry(provider: string, entry: CatalogEntry, modelId: string) {
  const namespace = await import(entry.pkg).catch(() => missingProvider(provider, entry.pkg))
  return rerankingModelFrom(namespace, entry.export, provider, entry.pkg, modelId)
}

export const providerReranking: RerankingRegistry = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, entry]) => [
    provider,
    (modelId: string) => resolveEntry(provider, entry, modelId),
  ]),
)
