import type { EmbeddingModel } from 'ai'
import { BreadError } from './types.js'

// Not a ProviderRegistry: that map returns a LanguageModel. A store EmbedFn
// is also a different type — this registry does not produce one.
export type EmbeddingRegistry = Record<
  string,
  (modelId: string) => EmbeddingModel | Promise<EmbeddingModel>
>

// Called when an embed runs, not when config is imported. Replacing
// `config.embeddings` changes the factory the next call sees.
export async function resolveEmbeddingModel(
  embeddings: EmbeddingRegistry | undefined,
  provider: string,
  modelId: string,
): Promise<EmbeddingModel> {
  const factory = embeddings?.[provider]
  if (typeof factory !== 'function') {
    throw new BreadError(
      `Embedding provider "${provider}" is not registered`,
      'UNKNOWN_EMBEDDING_PROVIDER',
      { provider },
    )
  }
  return factory(modelId)
}
