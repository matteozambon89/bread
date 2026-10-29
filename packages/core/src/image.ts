import type { ImageModel } from 'ai'
import { BreadError } from './types.js'

// A language-model factory returns a LanguageModel. An image factory returns
// an ImageModel for generateImage. They do not share a registry.
export type ImageRegistry = Record<string, (modelId: string) => ImageModel | Promise<ImageModel>>

export async function resolveImageModel(
  registry: ImageRegistry | undefined,
  provider: string,
  model: string,
): Promise<ImageModel> {
  if (registry === undefined) {
    throw new BreadError(
      'No image registry is configured. Set `image` in bread.config.ts ' +
        '(see @breadai/provider-image).',
      'IMAGE_NOT_CONFIGURED',
    )
  }
  const factory = registry[provider]
  if (!factory) {
    const known = Object.keys(registry)
    throw new BreadError(
      `Unknown image provider: "${provider}". ` +
        (known.length
          ? `Registered: ${known.join(', ')}. `
          : 'No image providers are registered. ') +
        'Set `image` in bread.config.ts (see @breadai/provider-image).',
      'UNKNOWN_IMAGE_PROVIDER',
      { provider, registered: known },
    )
  }
  return factory(model)
}
