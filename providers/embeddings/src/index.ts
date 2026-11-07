import type { EmbeddingModel } from 'ai'
import { BreadError, type EmbeddingRegistry } from '@breadai/core'

interface EmbeddingEntry {
  pkg: string
  export: string
  // Env vars the provider's own zero-config instance reads. A hint only —
  // the peer package is the source of truth and throws if one is missing.
  envVars: string[]
  // No default instance — construct via createXxx(fromEnv()).
  create?: {
    fromEnv: () => Record<string, string>
  }
}

interface EmbeddingProvider {
  embeddingModel(modelId: string): EmbeddingModel
}

const OPENAI_COMPATIBLE_ENV = ['OPENAI_COMPATIBLE_BASE_URL'] as const

// Keys shared with @breadai/provider-llm keep that catalog's name.
// voyage and alibaba are embedding-only. Language-model-only keys
// (anthropic, groq, xai, deepseek, cerebras, openrouter, workers-ai) stay out.
// @ai-sdk/quiverai's embeddingModel always throws, so it is not a key.
const ENTRIES: Record<string, EmbeddingEntry> = {
  openai: { pkg: '@ai-sdk/openai', export: 'openai', envVars: ['OPENAI_API_KEY'] },
  azure: { pkg: '@ai-sdk/azure', export: 'azure', envVars: ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME'] },
  google: { pkg: '@ai-sdk/google', export: 'google', envVars: ['GOOGLE_GENERATIVE_AI_API_KEY'] },
  'google-vertex': {
    pkg: '@ai-sdk/google-vertex',
    export: 'vertex',
    envVars: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'],
  },
  'amazon-bedrock': {
    pkg: '@ai-sdk/amazon-bedrock',
    export: 'bedrock',
    envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
  },
  mistral: { pkg: '@ai-sdk/mistral', export: 'mistral', envVars: ['MISTRAL_API_KEY'] },
  cohere: { pkg: '@ai-sdk/cohere', export: 'cohere', envVars: ['COHERE_API_KEY'] },
  togetherai: { pkg: '@ai-sdk/togetherai', export: 'togetherai', envVars: ['TOGETHER_AI_API_KEY'] },
  fireworks: { pkg: '@ai-sdk/fireworks', export: 'fireworks', envVars: ['FIREWORKS_API_KEY'] },
  deepinfra: { pkg: '@ai-sdk/deepinfra', export: 'deepinfra', envVars: ['DEEPINFRA_API_KEY'] },
  perplexity: { pkg: '@ai-sdk/perplexity', export: 'perplexity', envVars: ['PERPLEXITY_API_KEY'] },
  // The default `baseten` export has no modelURL, so embeddingModel always throws.
  // Embeddings need createBaseten({ modelURL }) pointed at /sync or /sync/v1.
  baseten: {
    pkg: '@ai-sdk/baseten',
    export: 'createBaseten',
    envVars: ['BASETEN_API_KEY', 'BASETEN_MODEL_URL'],
    create: {
      fromEnv: () => {
        const modelURL = process.env.BASETEN_MODEL_URL
        if (!modelURL) {
          throw new BreadError(
            'Provider "baseten" is not configured. Missing env vars: BASETEN_MODEL_URL',
            'PROVIDER_NOT_CONFIGURED',
            { provider: 'baseten', unset: ['BASETEN_MODEL_URL'] },
          )
        }
        if (!modelURL.includes('/sync')) {
          throw new BreadError(
            'Provider "baseten" embeddings require a /sync or /sync/v1 BASETEN_MODEL_URL',
            'PROVIDER_NOT_CONFIGURED',
            { provider: 'baseten' },
          )
        }
        const settings: Record<string, string> = { modelURL }
        const apiKey = process.env.BASETEN_API_KEY
        if (apiKey) settings.apiKey = apiKey
        return settings
      },
    },
  },
  // The default `ollama` export ignores OLLAMA_BASE_URL. When that var is set,
  // resolve through createOllama({ baseURL }). The embedding URL is that base
  // plus /embed, so a host root has to end in /api (see ollamaEmbeddingBaseURL).
  ollama: { pkg: 'ollama-ai-provider-v2', export: 'ollama', envVars: [] },
  'openai-compatible': {
    pkg: '@ai-sdk/openai-compatible',
    export: 'createOpenAICompatible',
    envVars: [...OPENAI_COMPATIBLE_ENV],
    create: {
      fromEnv: () => {
        const unset = OPENAI_COMPATIBLE_ENV.filter((name) => !process.env[name])
        if (unset.length > 0) {
          throw new BreadError(
            `Provider "openai-compatible" is not configured. Missing env vars: ${unset.join(', ')}`,
            'PROVIDER_NOT_CONFIGURED',
            { provider: 'openai-compatible', unset },
          )
        }
        const settings: Record<string, string> = {
          name: 'openai-compatible',
          baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL!,
        }
        const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY
        if (apiKey) settings.apiKey = apiKey
        return settings
      },
    },
  },
  voyage: { pkg: '@ai-sdk/voyage', export: 'voyage', envVars: ['VOYAGE_API_KEY'] },
  alibaba: { pkg: '@ai-sdk/alibaba', export: 'alibaba', envVars: ['ALIBABA_API_KEY'] },
}

function missingProvider(provider: string, pkg: string): never {
  throw new BreadError(`Provider ${pkg} is not installed. Run: bun add ${pkg}`, 'MISSING_PROVIDER', {
    provider,
  })
}

function missingExport(provider: string, pkg: string, exportName: string): never {
  throw new BreadError(
    `Provider package ${pkg} has no "${exportName}" export`,
    'PROVIDER_EXPORT_MISSING',
    { provider },
  )
}

// A failed evaluation of an installed peer must not look like a missing install.
function isMissingPackage(err: unknown, pkg: string): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false
  return err.message.includes(`'${pkg}'`) || err.message.includes(`"${pkg}"`)
}

// Some peers (voyage) export a plain object. Language-model catalogs can
// require a callable; an embedding provider only needs embeddingModel.
async function loadExport(provider: string, entry: EmbeddingEntry): Promise<unknown> {
  let namespace: Record<string, unknown>
  try {
    namespace = (await import(entry.pkg)) as Record<string, unknown>
  } catch (err) {
    if (isMissingPackage(err, entry.pkg)) missingProvider(provider, entry.pkg)
    throw err
  }
  const loaded = namespace[entry.export]
  if (loaded == null) missingExport(provider, entry.pkg, entry.export)
  return loaded
}

function asEmbeddingProvider(provider: string, value: unknown, entry: EmbeddingEntry): EmbeddingProvider {
  if (typeof (value as { embeddingModel?: unknown } | null)?.embeddingModel !== 'function') {
    throw new BreadError(
      `Provider package ${entry.pkg} export "${entry.export}" has no embeddingModel`,
      'PROVIDER_EXPORT_MISSING',
      { provider, pkg: entry.pkg, export: entry.export },
    )
  }
  return value as EmbeddingProvider
}

// Keyed by the env settings that built the instance. A later change to those
// vars must not keep serving the first host or key.
const createdProviders = new Map<string, { fingerprint: string; instance: EmbeddingProvider }>()

function settingsFingerprint(settings: Record<string, string>): string {
  return JSON.stringify(Object.keys(settings).sort().map((key) => [key, settings[key]]))
}

// createOllama joins baseURL with /embed. A host root (empty path or "/") has
// no /api prefix, so the call would miss the server's /api/embed route.
function ollamaEmbeddingBaseURL(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw
  }
  if (parsed.pathname.endsWith('/api')) return raw
  if (parsed.pathname !== '' && parsed.pathname !== '/') return raw
  parsed.pathname = '/api'
  return parsed.toString()
}

async function resolveEntry(
  provider: string,
  entry: EmbeddingEntry,
  modelId: string,
): Promise<EmbeddingModel> {
  const baseURL = process.env.OLLAMA_BASE_URL
  if (provider === 'ollama' && baseURL) {
    const createOllama = await loadExport(provider, { ...entry, export: 'createOllama' })
    if (typeof createOllama !== 'function') missingExport(provider, entry.pkg, 'createOllama')
    const instance = asEmbeddingProvider(
      provider,
      createOllama({ baseURL: ollamaEmbeddingBaseURL(baseURL) }),
      { ...entry, export: 'createOllama' },
    )
    return instance.embeddingModel(modelId)
  }

  if (entry.create) {
    // Import before fromEnv so a missing peer is MISSING_PROVIDER, not a config error.
    const loaded = await loadExport(provider, entry)
    if (typeof loaded !== 'function') missingExport(provider, entry.pkg, entry.export)
    const settings = entry.create.fromEnv()
    const fingerprint = settingsFingerprint(settings)
    const cached = createdProviders.get(provider)
    if (cached?.fingerprint === fingerprint) return cached.instance.embeddingModel(modelId)

    const instance = asEmbeddingProvider(provider, loaded(settings), entry)
    createdProviders.set(provider, { fingerprint, instance })
    return instance.embeddingModel(modelId)
  }

  const loaded = await loadExport(provider, entry)
  return asEmbeddingProvider(provider, loaded, entry).embeddingModel(modelId)
}

// Lazy optional peers for config.embeddings. openai-compatible is built with
// createOpenAICompatible: OPENAI_COMPATIBLE_BASE_URL is required, the API key
// is optional, and embeddingModel is the embeddings-API escape hatch.
export const providerEmbeddings: EmbeddingRegistry = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, entry]) => [
    provider,
    (modelId: string) => resolveEntry(provider, entry, modelId),
  ]),
)

export type { EmbeddingEntry }
export const embeddingEntries: Readonly<Record<string, EmbeddingEntry>> = ENTRIES
