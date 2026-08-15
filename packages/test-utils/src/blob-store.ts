import { v7 as uuidv7 } from 'uuid'
import type { BlobStore } from '@bread/core'

// A minimal, ephemeral BlobStore for tests — mirrors @bread/store-memory's
// role for BreadStore. Not published; lives here only.
export function memoryBlobStore(): BlobStore {
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
