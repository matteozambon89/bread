import type { TranscriptionModel } from 'ai'
import { BreadError, type TranscriptionRegistry } from '@breadai/core'

interface CatalogEntry {
  pkg: string
  export: string
}

// The whole transcription catalog. openai-compatible has no transcription
// factory. LiveKit and the AI Gateway are not entries.
const ENTRIES: Record<string, CatalogEntry> = {
  openai: { pkg: '@ai-sdk/openai', export: 'openai' },
  azure: { pkg: '@ai-sdk/azure', export: 'azure' },
  google: { pkg: '@ai-sdk/google', export: 'google' },
  'google-vertex': { pkg: '@ai-sdk/google-vertex', export: 'vertex' },
  mistral: { pkg: '@ai-sdk/mistral', export: 'mistral' },
  groq: { pkg: '@ai-sdk/groq', export: 'groq' },
  xai: { pkg: '@ai-sdk/xai', export: 'xai' },
  elevenlabs: { pkg: '@ai-sdk/elevenlabs', export: 'elevenLabs' },
  deepgram: { pkg: '@ai-sdk/deepgram', export: 'deepgram' },
  cartesia: { pkg: '@ai-sdk/cartesia', export: 'cartesia' },
  'fish-audio': { pkg: '@ai-sdk/fish-audio', export: 'fishAudio' },
  assemblyai: { pkg: '@ai-sdk/assemblyai', export: 'assemblyai' },
  gladia: { pkg: '@ai-sdk/gladia', export: 'gladia' },
  revai: { pkg: '@ai-sdk/revai', export: 'revai' },
  fal: { pkg: '@ai-sdk/fal', export: 'fal' },
}

function missingProvider(provider: string, pkg: string): never {
  throw new BreadError(`Provider ${pkg} is not installed. Run: bun add ${pkg}`, 'MISSING_PROVIDER', {
    provider,
  })
}

async function resolveEntry(provider: string, entry: CatalogEntry, modelId: string): Promise<TranscriptionModel> {
  const imported = await import(entry.pkg).catch(() => missingProvider(provider, entry.pkg))
  const factory = (imported as Record<string, unknown>)[entry.export]
  if (factory === null || (typeof factory !== 'function' && typeof factory !== 'object')) {
    throw new BreadError(
      `Provider package ${entry.pkg} has no "${entry.export}" export`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  const transcription = (factory as { transcription?: unknown }).transcription
  if (typeof transcription !== 'function') {
    throw new BreadError(
      `Provider package ${entry.pkg} has no "${entry.export}.transcription" export`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  return (transcription as (id?: string) => TranscriptionModel).call(factory, modelId)
}

// 15 catalog providers, ready to use as `config.transcription`:
//
//   import { providerTranscription } from '@breadai/provider-transcription'
//   export default defineConfig({ transcription: providerTranscription })
//
// Each factory lazy-imports its optional peer and returns
// `provider.transcription(modelId)`. Spreading this object never throws.
export const providerTranscription: TranscriptionRegistry = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, entry]) => [
    provider,
    (modelId: string) => resolveEntry(provider, entry, modelId),
  ]),
)
