import type { BlobStore } from '@breadai/core'
import { v7 as uuidv7 } from 'uuid'

// Process-local bytes so the speak pipeline can run without an S3 bucket.
// put()'s url is an HTTP GET on this process; get() accepts that url or the key.
// Swap for @breadai/store-s3 when the audio must outlive the process.
export function localBlobStore(): BlobStore {
  const blobs = new Map<string, { data: Uint8Array; mimeType?: string }>()
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      const prefix = '/blobs/'
      if (!url.pathname.startsWith(prefix)) return new Response('Not found', { status: 404 })
      const blob = blobs.get(decodeURIComponent(url.pathname.slice(prefix.length)))
      if (!blob) return new Response('Not found', { status: 404 })
      return new Response(blob.data, {
        headers: blob.mimeType ? { 'content-type': blob.mimeType } : {},
      })
    },
  })

  function idOf(keyOrUrl: string): string {
    if (!keyOrUrl.startsWith('http://') && !keyOrUrl.startsWith('https://')) return keyOrUrl
    const url = new URL(keyOrUrl)
    const prefix = '/blobs/'
    return url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : keyOrUrl
  }

  return {
    async put(data, opts) {
      const key = uuidv7()
      blobs.set(key, { data, ...(opts?.mimeType ? { mimeType: opts.mimeType } : {}) })
      return { key, url: `http://127.0.0.1:${server.port}/blobs/${encodeURIComponent(key)}` }
    },
    async get(key) {
      return blobs.get(idOf(key))
    },
    async delete(key) {
      blobs.delete(idOf(key))
    },
  }
}
