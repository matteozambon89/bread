import type { BlobStore } from '@breadai/core'
import { v7 as uuidv7 } from 'uuid'

// Process-local bytes so the speak pipeline can run without an S3 bucket.
// Swap for @breadai/store-s3 when the audio must outlive the process.
export function localBlobStore(): BlobStore {
  const blobs = new Map<string, { data: Uint8Array; mimeType?: string }>()
  return {
    async put(data, opts) {
      const key = uuidv7()
      blobs.set(key, { data, ...(opts?.mimeType ? { mimeType: opts.mimeType } : {}) })
      return { key, url: `memory://${key}` }
    },
    async get(key) {
      return blobs.get(key)
    },
  }
}
