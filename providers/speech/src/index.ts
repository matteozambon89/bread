import type { SpeechModel } from 'ai'
import { BreadError, type SpeechRegistry } from '@breadai/core'

interface CatalogEntry {
  pkg: string
  export: string
  // Env vars this provider's zero-config instance reads for auth (best-effort
  // hint — the @ai-sdk/* package itself throws if one is missing).
  envVars: string[]
}

// The whole speech catalog. Shared names match @breadai/provider-llm.
// openai-compatible has no speech factory and is not listed.
// xai and hume expose speech() with no model id; the step's model is still
// passed and those two ignore it.
const ENTRIES: Record<string, CatalogEntry> = {
  openai: { pkg: '@ai-sdk/openai', export: 'openai', envVars: ['OPENAI_API_KEY'] },
  azure: { pkg: '@ai-sdk/azure', export: 'azure', envVars: ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME'] },
  google: { pkg: '@ai-sdk/google', export: 'google', envVars: ['GOOGLE_GENERATIVE_AI_API_KEY'] },
  'google-vertex': {
    pkg: '@ai-sdk/google-vertex',
    export: 'vertex',
    envVars: ['GOOGLE_VERTEX_API_KEY', 'GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION'],
  },
  mistral: { pkg: '@ai-sdk/mistral', export: 'mistral', envVars: ['MISTRAL_API_KEY'] },
  xai: { pkg: '@ai-sdk/xai', export: 'xai', envVars: ['XAI_API_KEY'] },
  elevenlabs: { pkg: '@ai-sdk/elevenlabs', export: 'elevenLabs', envVars: ['ELEVENLABS_API_KEY'] },
  deepgram: { pkg: '@ai-sdk/deepgram', export: 'deepgram', envVars: ['DEEPGRAM_API_KEY'] },
  cartesia: { pkg: '@ai-sdk/cartesia', export: 'cartesia', envVars: ['CARTESIA_API_KEY'] },
  hume: { pkg: '@ai-sdk/hume', export: 'hume', envVars: ['HUME_API_KEY'] },
  'fish-audio': { pkg: '@ai-sdk/fish-audio', export: 'fishAudio', envVars: ['FISH_AUDIO_API_KEY'] },
  fal: { pkg: '@ai-sdk/fal', export: 'fal', envVars: ['FAL_API_KEY', 'FAL_KEY'] },
}

function missingProvider(provider: string, pkg: string): never {
  throw new BreadError(`Provider ${pkg} is not installed. Run: bun add ${pkg}`, 'MISSING_PROVIDER', {
    provider,
  })
}

async function loadExport(provider: string, entry: CatalogEntry): Promise<unknown> {
  const m = await import(entry.pkg).catch(() => missingProvider(provider, entry.pkg))
  const loaded = (m as Record<string, unknown>)[entry.export]
  if (loaded == null) {
    throw new BreadError(
      `Provider package ${entry.pkg} has no "${entry.export}" export`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  return loaded
}

async function resolveEntry(provider: string, entry: CatalogEntry, modelId: string): Promise<SpeechModel> {
  const loaded = await loadExport(provider, entry)
  const speech = (loaded as { speech?: unknown }).speech
  if (typeof speech !== 'function') {
    throw new BreadError(
      `Provider package ${entry.pkg} has no "speech" export`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  return (speech as (modelId?: string) => SpeechModel).call(loaded, modelId)
}

// Twelve speech providers for `config.speech` (or spread next to custom entries):
//
//   import { providerSpeech } from '@breadai/provider-speech'
//   export default defineConfig({ speech: providerSpeech })
//
// Each factory lazy-imports its optional peer on first use and returns that
// peer's SpeechModel. Spreading this object never throws.
export const providerSpeech: SpeechRegistry = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, entry]) => [
    provider,
    (modelId: string) => resolveEntry(provider, entry, modelId),
  ]),
)

export type { CatalogEntry }
export const speechEntries: Readonly<Record<string, CatalogEntry>> = ENTRIES
