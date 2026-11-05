import type { Experimental_VideoModelV3, Experimental_VideoModelV4 } from '@ai-sdk/provider'
import { BreadError } from './types.js'

// The object `experimental_generateVideo` accepts. A gateway model id string
// is not a registry result — this seam does not speak AI Gateway.
export type VideoModel = Experimental_VideoModelV3 | Experimental_VideoModelV4

// Separate from ProviderRegistry, which returns a LanguageModel. A factory may
// resolve asynchronously (see @breadai/provider-video, which lazy-imports each
// optional peer on first use).
export type VideoRegistry = Record<string, (modelId: string) => VideoModel | Promise<VideoModel>>

export async function resolveVideoModel(
  registry: VideoRegistry | undefined,
  provider: string,
  model: string,
): Promise<VideoModel> {
  if (registry === undefined) {
    throw new BreadError(
      'No video registry is configured. Set `video` in bread.config.ts ' +
        '(see @breadai/provider-video).',
      'VIDEO_NOT_CONFIGURED',
    )
  }
  // Inherited Object.prototype functions (`toString`, `constructor`, …) are not
  // registrations. `registry[name]` would otherwise return one and the caller
  // would treat that call's result as a model.
  const factory = Object.hasOwn(registry, provider) ? registry[provider] : undefined
  if (typeof factory !== 'function') {
    const known = Object.keys(registry)
    throw new BreadError(
      `Unknown video provider: "${provider}". ` +
        (known.length
          ? `Registered: ${known.join(', ')}. `
          : 'No video providers are registered. ') +
        'Set `video` in bread.config.ts (see @breadai/provider-video).',
      'UNKNOWN_VIDEO_PROVIDER',
      { provider, registered: known },
    )
  }
  return factory(model)
}

// A factory can return anything at runtime. v3 always generates in `doGenerate`.
// v4 may only implement the async `doStart` / `doStatus` pair.
export function isVideoModel(value: unknown): value is VideoModel {
  if (typeof value !== 'object' || value === null) return false
  const model = value as {
    specificationVersion?: unknown
    provider?: unknown
    modelId?: unknown
    doGenerate?: unknown
    doStart?: unknown
  }
  if (typeof model.provider !== 'string' || typeof model.modelId !== 'string') return false
  if (model.specificationVersion === 'v3') return typeof model.doGenerate === 'function'
  if (model.specificationVersion === 'v4') {
    return typeof model.doGenerate === 'function' || typeof model.doStart === 'function'
  }
  return false
}
