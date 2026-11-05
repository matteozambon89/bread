import type { SpeechModel } from 'ai'
import { BreadError } from './types.js'

// Speech models are not language models. config.providers stays a
// ProviderRegistry; this registry is config.speech.
export type SpeechRegistry = Record<string, (modelId: string) => SpeechModel | Promise<SpeechModel>>

export async function resolveSpeechModel(
  registry: SpeechRegistry | undefined,
  provider: string,
  model: string,
): Promise<SpeechModel> {
  if (registry === undefined) {
    throw new BreadError(
      'No speech registry is configured. Set `speech` in bread.config.ts ' +
        '(see @breadai/provider-speech).',
      'SPEECH_NOT_CONFIGURED',
    )
  }
  const factory = registry[provider]
  if (!factory) {
    const known = Object.keys(registry)
    throw new BreadError(
      `Unknown speech provider: "${provider}". ` +
        (known.length
          ? `Registered: ${known.join(', ')}. `
          : 'No speech providers are registered. ') +
        'Set `speech` in bread.config.ts (see @breadai/provider-speech).',
      'UNKNOWN_SPEECH_PROVIDER',
      { provider, registered: known },
    )
  }
  return factory(model)
}
