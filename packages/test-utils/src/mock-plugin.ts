import type { LanguageModel } from 'ai'
import type { ProviderRegistry } from '@bread/core'

// The runner resolves models through `resolveModel(ref, registries)`. An agent
// configured with `model: { provider: 'mock', model: <key> }` resolves to one
// of these test models with zero network access. See model-provider.ts.
export const MOCK_PROVIDER = 'mock'

/**
 * A `ProviderRegistry` fragment registering the `mock` provider, merged into
 * `config.providers`. `models` maps a model id to a fake `LanguageModel`; an
 * unmapped id falls back to the first registered model so single-model tests
 * can use any model string.
 */
export function mockProvider(models: Record<string, LanguageModel>): ProviderRegistry {
  const fallback = Object.values(models)[0]
  return {
    [MOCK_PROVIDER]: (modelId: string) => {
      const m = models[modelId] ?? fallback
      if (!m) throw new Error(`mockProvider: no model registered for "${modelId}"`)
      return m
    },
  }
}
