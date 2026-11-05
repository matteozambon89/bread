import { describe, expect, test } from 'bun:test'
import { localBlobStore } from './blob-store.ts'

describe('localBlobStore', () => {
  test('put url is readable with get and over HTTP', async () => {
    const blobs = localBlobStore()
    const data = new Uint8Array([9, 8, 7])
    const { url, key } = await blobs.put(data, { mimeType: 'audio/mpeg' })
    expect(url).not.toBe(key)

    const stored = await blobs.get(url)
    expect([...(stored?.data ?? [])]).toEqual([9, 8, 7])
    expect(stored?.mimeType).toBe('audio/mpeg')

    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('audio/mpeg')
    expect([...(new Uint8Array(await res.arrayBuffer()))]).toEqual([9, 8, 7])
  })
})
