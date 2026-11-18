import type { ImagePart, TextPart } from 'ai'
import type { BlobStore } from './storage/blob-store.js'

const FILE_REF_KEYS = new Set(['uri', 'mimeType', 'name', 'kind'])
const MEMORY_PREFIX = 'memory://'

// Session rows are JSON in the SQL stores. Base64 is still image data, so a
// later turn shows the same pixels. A Uint8Array would be a plain object.
function imageBytes(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

export async function userMessageContent(
  input: unknown,
  blobStore: BlobStore | undefined,
): Promise<string | Array<TextPart | ImagePart>> {
  if (typeof input === 'string') return input

  const file = imageFileRef(input)
  if (file) {
    const part = await toImagePart(file.uri, file.mimeType, blobStore)
    return part ? [part] : JSON.stringify(input)
  }

  if (!Array.isArray(input) || !input.some((item) => imageFilePart(item) !== undefined)) {
    return JSON.stringify(input)
  }

  const parts: Array<TextPart | ImagePart> = []
  for (const item of input) {
    const image = imageFilePart(item)
    if (image) {
      const part = await toImagePart(image.uri, image.mimeType, blobStore)
      parts.push(part ?? { type: 'text', text: JSON.stringify(item) })
      continue
    }
    if (isTextPart(item)) {
      parts.push({ type: 'text', text: item.text })
      continue
    }
    parts.push({ type: 'text', text: JSON.stringify(item) })
  }
  return parts
}

function imageFileRef(value: unknown): { uri: string; mimeType: string } | undefined {
  if (!isRecord(value)) return undefined
  if (!Object.keys(value).every((key) => FILE_REF_KEYS.has(key))) return undefined
  return imageFileFields(value)
}

function imageFilePart(value: unknown): { uri: string; mimeType: string } | undefined {
  if (!isRecord(value) || !isRecord(value.file)) return undefined
  return imageFileFields(value.file)
}

function imageFileFields(file: Record<string, unknown>): { uri: string; mimeType: string } | undefined {
  if (typeof file.uri !== 'string' || typeof file.mimeType !== 'string') return undefined
  if (!isImageMime(file.mimeType)) return undefined
  return { uri: file.uri, mimeType: file.mimeType }
}

function isTextPart(value: unknown): value is { text: string } {
  if (!isRecord(value) || typeof value.text !== 'string') return false
  return !('file' in value) && !('data' in value)
}

function isImageMime(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith('image/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// An image part is only the bytes blobStore.get returns. Any other image
// uri, including https, stays ordinary JSON text and is not fetched.
async function toImagePart(
  uri: string,
  mimeType: string,
  blobStore: BlobStore | undefined,
): Promise<ImagePart | undefined> {
  const bytes = await ownedBytes(uri, blobStore)
  if (!bytes) return undefined
  return { type: 'image', image: imageBytes(bytes), mediaType: mimeType }
}

async function ownedBytes(uri: string, blobStore: BlobStore | undefined): Promise<Uint8Array | undefined> {
  if (!blobStore) return undefined
  const key = blobKey(uri)
  if (key === undefined) return undefined
  try {
    const stored = await blobStore.get(key)
    return stored ? Uint8Array.from(stored.data) : undefined
  } catch (err) {
    if (uri.startsWith(MEMORY_PREFIX)) throw err
    return undefined
  }
}

function blobKey(uri: string): string | undefined {
  if (uri.startsWith(MEMORY_PREFIX)) {
    const key = uri.slice(MEMORY_PREFIX.length)
    return key === '' ? undefined : key
  }
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return undefined
  }
  if (url.protocol === 'file:') return lastSegment(url.pathname)
  if (url.protocol === 'https:' || url.protocol === 'http:') return pathKey(url.pathname)
  return undefined
}

function lastSegment(pathname: string): string | undefined {
  const decoded = decode(pathname)
  if (decoded === undefined) return undefined
  const name = decoded.split('/').pop() ?? ''
  return name === '' ? undefined : name
}

function pathKey(pathname: string): string | undefined {
  const decoded = decode(pathname)
  if (decoded === undefined) return undefined
  const path = decoded.replace(/^\/+/, '')
  return path === '' ? undefined : path
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}
