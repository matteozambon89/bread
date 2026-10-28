import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localBlobStore } from './blob.js'

const BYTES = new Uint8Array([1, 2, 3])

describe('localBlobStore', () => {
  test('put url is a file URL of the bytes that were written', async () => {
    const dir = `blobs-rel-${Date.now()}`
    try {
      const store = localBlobStore(dir)
      const { key, url } = await store.put(BYTES, { mimeType: 'image/png' })
      const parsed = new URL(url)
      expect(parsed.protocol).toBe('file:')
      expect(parsed.hostname).toBe('')
      expect(fileURLToPath(url)).toBe(resolve(dir, key))
      expect(new Uint8Array(await readFile(fileURLToPath(url)))).toEqual(BYTES)
      expect((await store.get(key))?.mimeType).toBe('image/png')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('get returns undefined for a missing blob and treats a missing mime sidecar as optional', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bread-blobs-'))
    try {
      const store = localBlobStore(dir)
      const { key } = await store.put(BYTES)
      const got = await store.get(key)
      expect(new Uint8Array(got?.data ?? [])).toEqual(BYTES)
      expect(got?.mimeType).toBeUndefined()
      expect(await store.get('missing')).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('get rejects a key that escapes the blob directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bread-blobs-'))
    const outside = join(resolve(dir), '..', `bread-blob-escape-${Date.now()}.db`)
    await writeFile(outside, 'secret')
    try {
      const store = localBlobStore(dir)
      await expect(store.get(`../${basename(outside)}`)).rejects.toThrow(/escapes/)
      await expect(store.get(outside)).rejects.toThrow(/escapes/)
      expect(await readFile(outside, 'utf8')).toBe('secret')
    } finally {
      await rm(outside, { force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('get rethrows a read error that is not a missing blob', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bread-blobs-'))
    try {
      await mkdir(join(dir, 'not-a-file'))
      const store = localBlobStore(dir)
      await expect(store.get('not-a-file')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
