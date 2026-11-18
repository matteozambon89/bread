import { generateImage, type ImageModel } from 'ai'
import type { BlobStore } from './storage/blob-store.js'

// The pipeline step accepts a source image. A draw task passes a string.
export type GenerateImagePrompt = Parameters<typeof generateImage>[0]['prompt']

export interface StoredImageFile {
  kind: 'file'
  uri: string
  mimeType: string
}

export type GenerateAndStoreResult =
  | { status: 'stored'; file: StoredImageFile }
  | { status: 'aborted' }
  | { status: 'failed'; error: unknown }

// generateImage can resolve after doGenerate aborts the signal. Do not store
// those bytes. A put that fails while the signal is aborted is that same
// cancellation, not a store error.
export async function generateAndStoreImage(options: {
  model: ImageModel
  prompt: GenerateImagePrompt
  blobStore: BlobStore
  signal?: AbortSignal
}): Promise<GenerateAndStoreResult> {
  let image: Awaited<ReturnType<typeof generateImage>>['image']
  try {
    const generated = await generateImage({
      model: options.model,
      prompt: options.prompt,
      n: 1,
      maxRetries: 0,
      ...(options.signal ? { abortSignal: options.signal } : {}),
    })
    image = generated.image
  } catch (error) {
    if (options.signal?.aborted) return { status: 'aborted' }
    return { status: 'failed', error }
  }
  if (options.signal?.aborted) return { status: 'aborted' }
  try {
    const stored = await options.blobStore.put(image.uint8Array, { mimeType: image.mediaType })
    return { status: 'stored', file: { kind: 'file', uri: stored.url, mimeType: image.mediaType } }
  } catch (error) {
    if (options.signal?.aborted) return { status: 'aborted' }
    return { status: 'failed', error }
  }
}
