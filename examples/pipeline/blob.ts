import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { v7 as uuidv7 } from 'uuid'
import type { BlobStore } from '@breadai/core'

// Local bytes for the cover pipeline. Not a store package — the image step
// needs some BlobStore, and this example does not require S3.
export function localBlobStore(dir: string): BlobStore {
  return {
    async put(data, opts) {
      await mkdir(dir, { recursive: true })
      const key = uuidv7()
      const path = blobPath(dir, key)
      await writeFile(path, data)
      if (opts?.mimeType) await writeFile(blobPath(dir, `${key}.mime`), opts.mimeType)
      // A relative dir (`./blobs`) must be file:///… of that file. `file://${path}`
      // parses the first segment as a host, so the URL does not open the bytes.
      return { key, url: pathToFileURL(path).href }
    },

    async get(key) {
      const path = blobPath(dir, key)
      let data: Uint8Array
      try {
        data = await readFile(path)
      } catch (err) {
        if (isMissing(err)) return undefined
        throw err
      }
      let mimeType: string | undefined
      try {
        const raw = await readFile(blobPath(dir, `${key}.mime`), 'utf8')
        mimeType = raw || undefined
      } catch (err) {
        if (!isMissing(err)) throw err
      }
      return { data, ...(mimeType ? { mimeType } : {}) }
    },
  }
}

// get() takes a caller-supplied key. Refuse anything that resolves outside dir
// (`../bread.db` would otherwise read the sqlite file beside this store).
function blobPath(dir: string, key: string): string {
  const root = resolve(dir)
  const path = resolve(root, key)
  if (!path.startsWith(root + sep)) {
    throw new Error(`Blob key "${key}" escapes ${dir}`)
  }
  return path
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
