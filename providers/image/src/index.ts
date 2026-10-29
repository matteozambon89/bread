import type { ImageModel } from 'ai'
import { BreadError, type ImageRegistry } from '@breadai/core'

interface CatalogEntry {
  pkg: string
  export: string
  // Env vars this provider's zero-config factory reads for auth (best-effort
  // hint — the @ai-sdk/* package itself throws if one is missing).
  envVars: string[]
  // openai-compatible exposes imageModel, not image.
  method?: 'imageModel'
  // No default instance — construct via createXxx(fromEnv()).
  create?: {
    fromEnv: () => Record<string, string>
  }
}

const OPENAI_COMPATIBLE_ENV = ['OPENAI_COMPATIBLE_BASE_URL'] as const

// Official image providers. Keys match @breadai/provider-llm when that vendor
// is already catalogued. Each is an optional peer, imported on first use.
const ENTRIES: Record<string, CatalogEntry> = {
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
  xai: { pkg: '@ai-sdk/xai', export: 'xai', envVars: ['XAI_API_KEY'] },
  togetherai: { pkg: '@ai-sdk/togetherai', export: 'togetherai', envVars: ['TOGETHER_AI_API_KEY'] },
  fireworks: { pkg: '@ai-sdk/fireworks', export: 'fireworks', envVars: ['FIREWORKS_API_KEY'] },
  deepinfra: { pkg: '@ai-sdk/deepinfra', export: 'deepinfra', envVars: ['DEEPINFRA_API_KEY'] },
  fal: { pkg: '@ai-sdk/fal', export: 'fal', envVars: ['FAL_API_KEY'] },
  luma: { pkg: '@ai-sdk/luma', export: 'luma', envVars: ['LUMA_API_KEY'] },
  replicate: { pkg: '@ai-sdk/replicate', export: 'replicate', envVars: ['REPLICATE_API_TOKEN'] },
  'black-forest-labs': {
    pkg: '@ai-sdk/black-forest-labs',
    export: 'blackForestLabs',
    envVars: ['BFL_API_KEY'],
  },
  bytedance: { pkg: '@ai-sdk/bytedance', export: 'byteDance', envVars: ['ARK_API_KEY'] },
  prodia: { pkg: '@ai-sdk/prodia', export: 'prodia', envVars: ['PRODIA_TOKEN'] },
  topaz: { pkg: '@ai-sdk/topaz', export: 'topaz', envVars: ['TOPAZ_API_KEY'] },
  quiverai: { pkg: '@ai-sdk/quiverai', export: 'quiverai', envVars: ['QUIVERAI_API_KEY'] },
  'openai-compatible': {
    pkg: '@ai-sdk/openai-compatible',
    export: 'createOpenAICompatible',
    envVars: [...OPENAI_COMPATIBLE_ENV],
    method: 'imageModel',
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
}

function missingProvider(provider: string, pkg: string): never {
  throw new BreadError(`Provider ${pkg} is not installed. Run: bun add ${pkg}`, 'MISSING_PROVIDER', {
    provider,
  })
}

async function loadExport(provider: string, entry: CatalogEntry): Promise<(...args: unknown[]) => unknown> {
  const m = await import(entry.pkg).catch(() => missingProvider(provider, entry.pkg))
  const factory = (m as Record<string, unknown>)[entry.export]
  if (typeof factory !== 'function') {
    throw new BreadError(
      `Provider package ${entry.pkg} has no "${entry.export}" export`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  return factory as (...args: unknown[]) => unknown
}

function imageModel(instance: object, entry: CatalogEntry, provider: string, modelId: string): ImageModel {
  const method = entry.method ?? 'image'
  const call = (instance as Record<string, unknown>)[method]
  if (typeof call !== 'function') {
    throw new BreadError(
      `Provider package ${entry.pkg} has no "${method}" model`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  return (call as (id: string) => ImageModel).call(instance, modelId)
}

const createdProviders = new Map<string, (modelId: string) => ImageModel>()

async function resolveEntry(provider: string, entry: CatalogEntry, modelId: string): Promise<ImageModel> {
  if (entry.create) {
    const cached = createdProviders.get(provider)
    if (cached) return cached(modelId)

    const factory = await loadExport(provider, entry)
    const settings = entry.create.fromEnv()
    const instance = factory(settings) as object
    const image = (id: string) => imageModel(instance, entry, provider, id)
    createdProviders.set(provider, image)
    return image(modelId)
  }

  const factory = await loadExport(provider, entry)
  return imageModel(factory as object, entry, provider, modelId)
}

// Eighteen image providers, ready to use as `config.image`:
//
//   import { providerImage } from '@breadai/provider-image'
//   export default defineConfig({ image: providerImage })
//
// Each factory lazy-imports its optional peer on first use, so spreading this
// object never throws. openai-compatible calls imageModel(modelId) on
// createOpenAICompatible(fromEnv()) — OPENAI_COMPATIBLE_BASE_URL is required.
export const providerImage: ImageRegistry = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, entry]) => [
    provider,
    (modelId: string) => resolveEntry(provider, entry, modelId),
  ]),
)

export type { CatalogEntry }
export const imageEntries: Readonly<Record<string, CatalogEntry>> = ENTRIES
