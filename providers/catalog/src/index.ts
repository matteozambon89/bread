import type { LanguageModel } from 'ai'
import { BreadError, type ProviderRegistry } from '@bread/core'

interface CatalogEntry {
  pkg: string
  export: string
  // Env vars this provider's zero-config factory reads for auth (best-effort
  // hint for `bread provider add/list` — the @ai-sdk/* package itself is the
  // actual source of truth and throws its own error if one is missing).
  envVars: string[]
}

// Every official @ai-sdk/* provider that exposes a default `provider(modelId)`
// instance. Each is an optional peer dep, imported lazily so installing this
// catalog doesn't pull in every SDK.
const ENTRIES: Record<string, CatalogEntry> = {
  openai: { pkg: '@ai-sdk/openai', export: 'openai', envVars: ['OPENAI_API_KEY'] },
  anthropic: { pkg: '@ai-sdk/anthropic', export: 'anthropic', envVars: ['ANTHROPIC_API_KEY'] },
  google: { pkg: '@ai-sdk/google', export: 'google', envVars: ['GOOGLE_GENERATIVE_AI_API_KEY'] },
  'google-vertex': {
    pkg: '@ai-sdk/google-vertex',
    export: 'vertex',
    envVars: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'],
  },
  azure: { pkg: '@ai-sdk/azure', export: 'azure', envVars: ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME'] },
  'amazon-bedrock': {
    pkg: '@ai-sdk/amazon-bedrock',
    export: 'bedrock',
    envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
  },
  mistral: { pkg: '@ai-sdk/mistral', export: 'mistral', envVars: ['MISTRAL_API_KEY'] },
  groq: { pkg: '@ai-sdk/groq', export: 'groq', envVars: ['GROQ_API_KEY'] },
  cohere: { pkg: '@ai-sdk/cohere', export: 'cohere', envVars: ['COHERE_API_KEY'] },
  xai: { pkg: '@ai-sdk/xai', export: 'xai', envVars: ['XAI_API_KEY'] },
  deepseek: { pkg: '@ai-sdk/deepseek', export: 'deepseek', envVars: ['DEEPSEEK_API_KEY'] },
  togetherai: { pkg: '@ai-sdk/togetherai', export: 'togetherai', envVars: ['TOGETHER_AI_API_KEY'] },
  fireworks: { pkg: '@ai-sdk/fireworks', export: 'fireworks', envVars: ['FIREWORKS_API_KEY'] },
  deepinfra: { pkg: '@ai-sdk/deepinfra', export: 'deepinfra', envVars: ['DEEPINFRA_API_KEY'] },
  cerebras: { pkg: '@ai-sdk/cerebras', export: 'cerebras', envVars: ['CEREBRAS_API_KEY'] },
  perplexity: { pkg: '@ai-sdk/perplexity', export: 'perplexity', envVars: ['PERPLEXITY_API_KEY'] },
  baseten: { pkg: '@ai-sdk/baseten', export: 'baseten', envVars: ['BASETEN_API_KEY'] },
  // ollama-ai-provider-v2 implements AI SDK spec v2; the original
  // ollama-ai-provider is v1-only and fails under AI SDK 5. Zero-config
  // against a local server — OLLAMA_BASE_URL is optional, not required.
  ollama: { pkg: 'ollama-ai-provider-v2', export: 'ollama', envVars: [] },
}

function missingProvider(provider: string, pkg: string): never {
  throw new BreadError(`Provider ${pkg} is not installed. Run: bun add ${pkg}`, 'MISSING_PROVIDER', {
    provider,
  })
}

async function resolveEntry(provider: string, entry: CatalogEntry, modelId: string): Promise<LanguageModel> {
  const m = await import(entry.pkg).catch(() => missingProvider(provider, entry.pkg))
  const factory = (m as Record<string, unknown>)[entry.export]
  if (typeof factory !== 'function') {
    throw new BreadError(
      `Provider package ${entry.pkg} has no "${entry.export}" export`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  return (factory as (id: string) => LanguageModel)(modelId)
}

// The 18 official @ai-sdk/* built-ins, ready to use as `config.providers` (or
// spread into a larger registry alongside custom entries):
//
//   import { providerCatalog } from '@bread/provider-catalog'
//   export default defineConfig({ providers: providerCatalog })
//
// @ai-sdk/openai-compatible is deliberately not included here — it has no
// zero-config default instance (it needs a baseURL). Build your own entry with
// `createOpenAICompatible()` and register it under whatever name you like:
//
//   import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
//   providers: { ...providerCatalog, 'my-host': createOpenAICompatible({ baseURL: '...' }) }
export const providerCatalog: ProviderRegistry = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, entry]) => [
    provider,
    (modelId: string) => resolveEntry(provider, entry, modelId),
  ]),
)

// Read-only view of the same catalog data (pkg name + auth env var hints),
// for tooling like `bread provider list`/`add` — kept as one source of truth
// instead of a second hardcoded provider->package map.
export type { CatalogEntry }
export const providerEntries: Readonly<Record<string, CatalogEntry>> = ENTRIES
