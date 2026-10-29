import { BreadError, type VideoModel, type VideoRegistry } from '@breadai/core'

export interface VideoCatalogEntry {
  pkg: string
  // The provider instance export. Call `instance.video(modelId)` — not the
  // instance itself, which is the language or image factory when one exists.
  export: string
}

// Every AI SDK provider that exposes a default instance with `.video(modelId)`.
// Each is an optional peer, imported lazily so installing this catalog does
// not pull in every SDK. No openai-compatible, LiveKit, or AI Gateway entry.
const ENTRIES: Record<string, VideoCatalogEntry> = {
  google: { pkg: '@ai-sdk/google', export: 'google' },
  'google-vertex': { pkg: '@ai-sdk/google-vertex', export: 'vertex' },
  xai: { pkg: '@ai-sdk/xai', export: 'xai' },
  alibaba: { pkg: '@ai-sdk/alibaba', export: 'alibaba' },
  fal: { pkg: '@ai-sdk/fal', export: 'fal' },
  replicate: { pkg: '@ai-sdk/replicate', export: 'replicate' },
  'black-forest-labs': { pkg: '@ai-sdk/black-forest-labs', export: 'blackForestLabs' },
  bytedance: { pkg: '@ai-sdk/bytedance', export: 'byteDance' },
  klingai: { pkg: '@ai-sdk/klingai', export: 'klingai' },
  minimax: { pkg: '@ai-sdk/minimax', export: 'minimax' },
  prodia: { pkg: '@ai-sdk/prodia', export: 'prodia' },
  topaz: { pkg: '@ai-sdk/topaz', export: 'topaz' },
  heygen: { pkg: '@ai-sdk/heygen', export: 'heygen' },
}

function missingProvider(provider: string, pkg: string): never {
  throw new BreadError(`Provider ${pkg} is not installed. Run: bun add ${pkg}`, 'MISSING_PROVIDER', {
    provider,
  })
}

async function resolveEntry(provider: string, entry: VideoCatalogEntry, modelId: string): Promise<VideoModel> {
  const m = await import(entry.pkg).catch(() => missingProvider(provider, entry.pkg))
  const loaded = (m as Record<string, unknown>)[entry.export]
  // google/vertex/xai/alibaba/minimax are callable. fal, replicate, and the
  // other video-only peers are plain objects. Both expose `.video(modelId)`.
  if (typeof loaded !== 'function' && (loaded === null || typeof loaded !== 'object')) {
    throw new BreadError(
      `Provider package ${entry.pkg} has no "${entry.export}" export`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  const video = (loaded as { video?: unknown }).video
  if (typeof video !== 'function') {
    throw new BreadError(
      `Provider package ${entry.pkg} has no "${entry.export}.video" export`,
      'PROVIDER_EXPORT_MISSING',
      { provider },
    )
  }
  return (video as (id: string) => VideoModel)(modelId)
}

// The 13 catalog providers, ready to use as `config.video` (or spread into a
// larger registry alongside custom entries):
//
//   import { providerVideo } from '@breadai/provider-video'
//   export default defineConfig({ video: providerVideo })
//
// Each factory lazy-imports its optional peer on first use and returns that
// peer's experimental video model (`instance.video(modelId)`).
export const providerVideo: VideoRegistry = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, entry]) => [
    provider,
    (modelId: string) => resolveEntry(provider, entry, modelId),
  ]),
)

export const videoEntries: Readonly<Record<string, VideoCatalogEntry>> = ENTRIES
