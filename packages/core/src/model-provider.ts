import type { CallSettings, JSONValue, LanguageModel } from 'ai'
import { BreadError } from './types.js'

export interface ModelRef {
  provider: string
  model: string
  // Universal AI SDK call settings (maxOutputTokens, temperature, topP, topK,
  // presencePenalty, frequencyPenalty, stopSequences, seed) — identical shape
  // for every provider, spread as-is into streamText/generateObject.
  settings?: CallSettings
  // Provider-specific knobs (e.g. ollama's `think`, anthropic's `thinking`,
  // groq's `reasoningEffort`) — namespaced under `provider` automatically
  // (`providerOptions: { [provider]: providerOptions }`) rather than making
  // the caller repeat the provider name. Not validated by bread — the
  // provider package validates its own shape.
  providerOptions?: Record<string, JSONValue>
}

// A named-instance registry: keys are provider names as referenced by
// `model.provider`, values are callable AI SDK provider instances (or any
// custom factory) — e.g. `{ anthropic, 'anthropic-eu': createAnthropic({...}) }`.
// A factory may resolve asynchronously (see @breadai/provider-catalog, which
// lazy-imports each @ai-sdk/* package on first use).
export type ProviderRegistry = Record<
  string,
  (modelId: string) => LanguageModel | Promise<LanguageModel>
>

// Flattens a ModelRef's settings/providerOptions into what streamText/
// generateObject expect — the one place this shape is assembled, so
// runner.ts's two call sites and task.ts's stay in sync.
export function modelCallOptions(ref: ModelRef): CallSettings & {
  providerOptions?: Record<string, Record<string, JSONValue>>
} {
  return {
    ...ref.settings,
    ...(ref.providerOptions ? { providerOptions: { [ref.provider]: ref.providerOptions } } : {}),
  }
}

// Resolves a model against an ordered list of registries — first match wins.
// Callers pass the most specific registry first (e.g. an agent's own
// `cfg.providers` ahead of the global `config.providers`), so resolution is
// agent → global → error. Core has no built-in providers of its own; install
// `@breadai/provider-catalog` for the common @ai-sdk/* set, or register your own.
export async function resolveModel(
  ref: ModelRef,
  registries?: (ProviderRegistry | undefined)[],
): Promise<LanguageModel> {
  for (const registry of registries ?? []) {
    const factory = registry?.[ref.provider]
    if (factory) return factory(ref.model)
  }

  const known = [...new Set((registries ?? []).flatMap((r) => (r ? Object.keys(r) : [])))]
  throw new BreadError(
    `Unknown model provider: "${ref.provider}". ` +
      (known.length ? `Registered: ${known.join(', ')}. ` : 'No providers are registered. ') +
      'Set `providers` in bread.config.ts (see @breadai/provider-catalog for the built-in AI SDK ' +
      "providers), or override per-agent via the agent's `providers`.",
    'UNKNOWN_PROVIDER',
    { provider: ref.provider },
  )
}
