import assert from 'node:assert/strict'
import type { BlobStore } from '@bread/core'

// A behavioral contract every BlobStore implementation must satisfy,
// expressed as runner-agnostic cases (node:assert), like the store and
// transport contracts.

export interface BlobCase {
  name: string
  fn: (blobStore: BlobStore) => Promise<void>
}

export function blobContractCases(): BlobCase[] {
  return [
    {
      name: 'put then get round-trips the exact bytes',
      fn: async (blobStore) => {
        const data = new Uint8Array([1, 2, 3, 4, 5])
        const { key } = await blobStore.put(data)
        const got = await blobStore.get(key)
        assert.ok(got, 'expected a stored blob')
        assert.deepEqual(Array.from(got!.data), Array.from(data))
      },
    },
    {
      name: 'put preserves the given mimeType',
      fn: async (blobStore) => {
        const { key } = await blobStore.put(new Uint8Array([1]), { mimeType: 'image/png' })
        const got = await blobStore.get(key)
        assert.equal(got?.mimeType, 'image/png')
      },
    },
    {
      name: 'put returns a non-empty url',
      fn: async (blobStore) => {
        const { url } = await blobStore.put(new Uint8Array([1]))
        assert.ok(url, 'expected a non-empty url')
      },
    },
    {
      name: 'put generates a key without the caller supplying one',
      fn: async (blobStore) => {
        const a = await blobStore.put(new Uint8Array([1]))
        const b = await blobStore.put(new Uint8Array([2]))
        assert.ok(a.key, 'expected a generated key')
        assert.notEqual(a.key, b.key)
      },
    },
    {
      name: 'get on an unknown key returns undefined',
      fn: async (blobStore) => {
        const got = await blobStore.get('does-not-exist')
        assert.equal(got, undefined)
      },
    },
  ]
}

/**
 * Registers the contract with `bun:test`. Per case: `makeBlobStore()` builds
 * a fresh store, the case runs — no init()/close() lifecycle, since BlobStore
 * has none.
 */
export function runBlobContract(name: string, makeBlobStore: () => Promise<BlobStore> | BlobStore): void {
  // Lazy require keeps this module importable under node:test.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { describe, test } = require('bun:test') as typeof import('bun:test')

  describe(`blob store contract — ${name}`, () => {
    for (const c of blobContractCases()) {
      test(c.name, async () => {
        const blobStore = await makeBlobStore()
        await c.fn(blobStore)
      })
    }
  })
}
