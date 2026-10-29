import type { EmbeddingModel } from 'ai'

// Not a ProviderRegistry: that map returns a LanguageModel. A store EmbedFn
// is also a different type — this registry does not produce one.
export type EmbeddingRegistry = Record<
  string,
  (modelId: string) => EmbeddingModel | Promise<EmbeddingModel>
>
