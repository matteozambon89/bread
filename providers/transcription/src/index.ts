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

function isMissingPackage(err: unknown, pkg: string): boolean {
  if (typeof err !== 'object' || err === null) return false
  if ((err as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND') return false
  const specifier = (err as { specifier?: unknown }).specifier
  if (typeof specifier === 'string') return specifier === pkg
  const message = err instanceof Error ? err.message : ''
  return message.includes(`'${pkg}'`) || message.includes(`"${pkg}"`)
}

async function loadPackage(provider: string, pkg: string): Promise<unknown> {
  try {
    return await import(pkg)
  } catch (err) {
    if (isMissingPackage(err, pkg)) missingProvider(provider, pkg)
    throw err
  }
}

// The default `vertex` export reads GOOGLE_VERTEX_API_KEY and enables Express
// Mode. transcription() then throws. A non-string apiKey skips that read.
function googleVertexModel(imported: Record<string, unknown>, provider: string, modelId: string): TranscriptionModel {
  const createVertex = imported.createVertex
  if (typeof createVertex !== 'function') {
    throw new BreadError(
      'Provider package @ai-sdk/google-vertex has no "createVertex" export',
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  const factory = (createVertex as (options: { apiKey: boolean }) => { transcription?: unknown })({
    apiKey: false,
  })
  const transcription = factory?.transcription
  if (typeof transcription !== 'function') {
    throw new BreadError(
      'Provider package @ai-sdk/google-vertex has no "createVertex().transcription" export',
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  return (transcription as (id: string) => TranscriptionModel).call(factory, modelId)
}

async function resolveEntry(provider: string, entry: CatalogEntry, modelId: string): Promise<TranscriptionModel> {
  const imported = (await loadPackage(provider, entry.pkg)) as Record<string, unknown>
  if (provider === 'google-vertex') return googleVertexModel(imported, provider, modelId)
  const factory = imported[entry.export]
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
  // Gladia's SDK sends any id other than "default" as the API model field.
  // The step still requires a model string; the single Gladia model ignores it.
  if (provider === 'gladia') return (transcription as () => TranscriptionModel).call(factory)
  return (transcription as (id?: string) => TranscriptionModel).call(factory, modelId)
}

// 15 catalog providers, ready to use as `config.transcription`:
//
//   import { providerTranscription } from '@breadai/provider-transcription'
//   export default defineConfig({ transcription: providerTranscription })
//
// Each factory lazy-imports its optional peer. Gladia omits the model id.
// google-vertex uses createVertex so Express Mode stays off. Spreading this
// object never throws.
export const providerTranscription: TranscriptionRegistry = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, entry]) => [
    provider,
    (modelId: string) => resolveEntry(provider, entry, modelId),
  ]),
)
