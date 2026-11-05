import { embed } from 'ai'
import type { EmbeddingModel } from 'ai'
import { BreadError, type BreadConfig } from './types.js'

// Not a ProviderRegistry: that map returns a LanguageModel. A store EmbedFn
// is also a different type — this registry does not produce one.
export type EmbeddingRegistry = Record<
  string,
  (modelId: string) => EmbeddingModel | Promise<EmbeddingModel>
>

export type EmbedFn = (text: string) => Promise<number[]>

export interface EmbeddingRef {
  provider: string
  model: string
}

export type StoreEmbed = EmbedFn | EmbeddingRef

// Per store object, not a copied registry: bread dev evaluates the config
// twice and discards the first, and a later `config.embeddings` assignment
// must be the one a write reads.
const boundConfigs = new WeakMap<object, BreadConfig>()

export function bindStoreConfig(store: object, config: BreadConfig): void {
  boundConfigs.set(store, config)
}

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

// Function specs are called as-is and do not read `config.embeddings`.
// A ref is resolved here, from the object `defineConfig` bound, on document
// ingest, document search, knowledge-node write, and knowledge query.
export async function embedStoreText(
  store: object,
  spec: StoreEmbed,
  text: string,
): Promise<number[]> {
  if (typeof spec === 'function') return spec(text)
  const config = boundConfigs.get(store)
  if (!config) {
    throw new BreadError(
      'No config is bound to this store. Pass the store through defineConfig before using an embedding ref.',
      'EMBEDDINGS_NOT_BOUND',
    )
  }
  const model = await resolveEmbeddingModel(config.embeddings, spec.provider, spec.model)
  const { embedding } = await embed({ model, value: text, maxRetries: 0 })
  return embedding
}
