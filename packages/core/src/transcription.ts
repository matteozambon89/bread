import type { TranscriptionModel } from 'ai'
import { isFileOutput } from './storage/blob-store.js'
import { BreadError } from './types.js'

// Separate from ProviderRegistry: those factories return a LanguageModel.
// @breadai/provider-transcription fills this. Core has no built-ins.
export type TranscriptionRegistry = Record<
  string,
  (modelId: string) => TranscriptionModel | Promise<TranscriptionModel>
>

export async function resolveTranscriptionModel(
  registry: TranscriptionRegistry | undefined,
  provider: string,
  model: string,
): Promise<TranscriptionModel> {
  if (registry === undefined) {
    throw new BreadError(
      'No transcription registry is configured. Set `transcription` in bread.config.ts ' +
        '(see @breadai/provider-transcription).',
      'TRANSCRIPTION_NOT_CONFIGURED',
    )
  }
  const factory = registry[provider]
  if (!factory) {
    const known = Object.keys(registry)
    throw new BreadError(
      `Unknown transcription provider: "${provider}". ` +
        (known.length
          ? `Registered: ${known.join(', ')}. `
          : 'No transcription providers are registered. ') +
        'Set `transcription` in bread.config.ts (see @breadai/provider-transcription).',
      'UNKNOWN_TRANSCRIPTION_PROVIDER',
      { provider, registered: known },
    )
  }
  return factory(model)
}

// The pipeline value must already be an http(s) FileOutput. transcribe downloads
// that url; this does not read the blob.
export function transcriptionAudioUrl(
  value: unknown,
  where: { pipelineId: string; stepIndex: number },
): URL {
  if (!isFileOutput(value)) {
    throw new BreadError(
      `Pipeline "${where.pipelineId}" step ${where.stepIndex} transcription input must be a FileOutput.`,
      'TRANSCRIPTION_INPUT',
      where,
    )
  }
  let url: URL
  try {
    url = new URL(value.uri)
  } catch {
    throw uriError(where, value.uri)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw uriError(where, value.uri)
  return url
}

function uriError(where: { pipelineId: string; stepIndex: number }, uri: string): BreadError {
  return new BreadError(
    `Pipeline "${where.pipelineId}" step ${where.stepIndex} transcription requires an http(s) uri.`,
    'TRANSCRIPTION_INPUT',
    { ...where, uri },
  )
}
