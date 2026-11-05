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

// Only the missing peer itself is MISSING_PROVIDER. A broken install or a
// missing transitive module keeps the original error.
function directlyMissing(error: unknown, pkg: string): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: string }).code
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false
  const match = error.message.match(/Cannot find (?:package|module) ['"]([^'"]+)['"]/)
  return match?.[1] === pkg
}

async function resolveEntry(provider: string, entry: CatalogEntry, modelId: string) {
  try {
    const namespace = await import(entry.pkg)
    return rerankingModelFrom(namespace, entry.export, provider, entry.pkg, modelId)
  } catch (error) {
    if (directlyMissing(error, entry.pkg)) missingProvider(provider, entry.pkg)
    throw error
  }
}

export const providerReranking: RerankingRegistry = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, entry]) => [
    provider,
    (modelId: string) => resolveEntry(provider, entry, modelId),
  ]),
)
