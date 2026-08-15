import type { BlobStore, FileOutput } from '@breadai/core'

interface TextPart {
  kind: 'text'
  text: string
}

interface DataPart {
  kind: 'data'
  data: Record<string, unknown>
}

// Canonical, version-independent shape — v0.3's file.fileWithUri/mimeType/name
// normalize into this, the same way v1.0's url/mediaType/filename will (see
// v1/message.ts). uri is always present: bread never stores a file without
// producing a retrievable reference (see MAX_INLINE_FILE_BYTES below for the
// inline-bytes path, which uploads then uses the resulting url here).
interface FilePart {
  kind: 'file'
  uri: string
  mimeType?: string
  name?: string
}

// Inline file bytes are decoded and uploaded to blobStore, so an unbounded
// base64 payload is a real resource risk — reject before decoding. Checked
// against the base64 *string* length (cheap upper bound: decoded bytes ≈
// base64 length * 3/4) rather than the decoded size, to avoid decoding a
// too-large payload just to measure it.
const MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024
const MAX_INLINE_FILE_BASE64_CHARS = Math.ceil(MAX_INLINE_FILE_BYTES / 3) * 4

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

interface IncomingMessage {
  role: 'user' | 'agent'
  parts: unknown[]
  messageId: string
  kind: 'message'
  contextId?: string
}

function fileTag(f: FilePart): Record<string, unknown> {
  return { uri: f.uri, ...(f.mimeType ? { mimeType: f.mimeType } : {}), ...(f.name ? { name: f.name } : {}) }
}

// Inverse of extractInput's file-part parsing — builds the real outbound v0.3 wire Part
// for a FileOutput the agent is handing back (not reusable with fileTag(), which builds
// the canonical *input*-tagged shape, not a real wire Part).
export function toOutputFilePart(f: FileOutput): Record<string, unknown> {
  return {
    kind: 'file',
    file: { fileWithUri: f.uri, ...(f.mimeType ? { mimeType: f.mimeType } : {}), ...(f.name ? { name: f.name } : {}) },
  }
}

export async function extractInput(
  params: unknown,
  blobStore?: BlobStore,
): Promise<{ ok: true; input: unknown; contextId?: string } | { ok: false; error: string }> {
  const message = (params as { message?: unknown } | undefined)?.message as IncomingMessage | undefined
  if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
    return { ok: false, error: 'message.parts must contain at least one part' }
  }
  const parts: (TextPart | DataPart | FilePart)[] = []
  for (const part of message.parts) {
    const p = part as { kind?: unknown; text?: unknown; data?: unknown; file?: unknown }
    if (p.kind === 'text' && typeof p.text === 'string') {
      parts.push({ kind: 'text', text: p.text })
    } else if (p.kind === 'data' && isPlainObject(p.data)) {
      parts.push({ kind: 'data', data: p.data })
    } else if (p.kind === 'data') {
      return { ok: false, error: 'a "data" part\'s data field must be a JSON object' }
    } else if (p.kind === 'file' && isPlainObject(p.file) && typeof p.file.fileWithUri === 'string') {
      parts.push({
        kind: 'file',
        uri: p.file.fileWithUri,
        ...(typeof p.file.mimeType === 'string' ? { mimeType: p.file.mimeType } : {}),
        ...(typeof p.file.name === 'string' ? { name: p.file.name } : {}),
      })
    } else if (p.kind === 'file' && isPlainObject(p.file) && typeof p.file.fileWithBytes === 'string') {
      const bytes = p.file.fileWithBytes
      if (bytes.length > MAX_INLINE_FILE_BASE64_CHARS) {
        return { ok: false, error: `inline file bytes ("fileWithBytes") exceed the ${MAX_INLINE_FILE_BYTES} byte limit — use a URI-referenced file ("fileWithUri") for larger content` }
      }
      if (!blobStore) {
        return {
          ok: false,
          error: 'inline file bytes ("fileWithBytes") require a blob store to be configured — see docs/store.md, or send a URI-referenced file ("fileWithUri") instead',
        }
      }
      const mimeType = typeof p.file.mimeType === 'string' ? p.file.mimeType : undefined
      const { url } = await blobStore.put(Buffer.from(bytes, 'base64'), mimeType ? { mimeType } : {})
      parts.push({
        kind: 'file',
        uri: url,
        ...(mimeType ? { mimeType } : {}),
        ...(typeof p.file.name === 'string' ? { name: p.file.name } : {}),
      })
    } else {
      return { ok: false, error: 'unsupported part — only "text", "data", and "file" parts are accepted' }
    }
  }

  let input: unknown
  if (parts.every((p) => p.kind === 'text')) {
    input = parts.map((p) => (p as TextPart).text).join('\n')
  } else if (parts.length === 1 && parts[0]!.kind === 'data') {
    input = (parts[0] as DataPart).data
  } else if (parts.length === 1 && parts[0]!.kind === 'file') {
    input = fileTag(parts[0] as FilePart)
  } else {
    input = parts.map((p) => (p.kind === 'text' ? { text: p.text } : p.kind === 'data' ? { data: p.data } : { file: fileTag(p) }))
  }
  return { ok: true, input, ...(message.contextId ? { contextId: message.contextId } : {}) }
}
