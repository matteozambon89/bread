import type { BlobStore, FileOutput } from '@bread/core'

// v1.0 drops the `kind` discriminator entirely — a Part is a `oneof`,
// identified by which named field is present on the wire (`text`/`raw`/
// `url`/`data`). We accept `text`, `data`, and `url` (URI-referenced file);
// `raw` (inline bytes) requires a blobStore — see MAX_INLINE_FILE_BYTES below.
interface IncomingPart {
  text?: string
  raw?: string
  url?: string
  filename?: string
  mediaType?: string
  data?: unknown
}

// Canonical, version-independent shape — matches v0.3/message.ts's FilePart.
// uri is always present: bread never stores a file without producing a
// retrievable reference (the inline-bytes path uploads then uses the
// resulting url here).
type ResolvedPart =
  | { kind: 'text'; text: string }
  | { kind: 'data'; data: Record<string, unknown> }
  | { kind: 'file'; uri: string; mimeType?: string; name?: string }

// See v0.3/message.ts's identical constant for the rationale (reject on the
// base64 string length, before decoding).
const MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024
const MAX_INLINE_FILE_BASE64_CHARS = Math.ceil(MAX_INLINE_FILE_BYTES / 3) * 4

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

interface IncomingMessage {
  role: 'ROLE_USER' | 'ROLE_AGENT'
  parts: unknown[]
  messageId: string
  contextId?: string
}

function fileTag(f: Extract<ResolvedPart, { kind: 'file' }>): Record<string, unknown> {
  return { uri: f.uri, ...(f.mimeType ? { mimeType: f.mimeType } : {}), ...(f.name ? { name: f.name } : {}) }
}

// Inverse of extractInput's file-part parsing — builds the real outbound v1.0 wire Part
// (flat oneof, no kind/file nesting) for a FileOutput the agent is handing back.
export function toOutputFilePart(f: FileOutput): Record<string, unknown> {
  return { url: f.uri, ...(f.mimeType ? { mediaType: f.mimeType } : {}), ...(f.name ? { filename: f.name } : {}) }
}

export async function extractInput(
  params: unknown,
  blobStore?: BlobStore,
): Promise<{ ok: true; input: unknown; contextId?: string } | { ok: false; error: string }> {
  const message = (params as { message?: unknown } | undefined)?.message as IncomingMessage | undefined
  if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
    return { ok: false, error: 'message.parts must contain at least one part' }
  }
  const parts: ResolvedPart[] = []
  for (const part of message.parts) {
    const p = part as IncomingPart
    if (typeof p.text === 'string') {
      parts.push({ kind: 'text', text: p.text })
    } else if ('data' in p && isPlainObject(p.data)) {
      parts.push({ kind: 'data', data: p.data })
    } else if ('data' in p) {
      return { ok: false, error: 'a "data" part\'s data field must be a JSON object' }
    } else if (typeof p.url === 'string') {
      parts.push({
        kind: 'file',
        uri: p.url,
        ...(typeof p.mediaType === 'string' ? { mimeType: p.mediaType } : {}),
        ...(typeof p.filename === 'string' ? { name: p.filename } : {}),
      })
    } else if (typeof p.raw === 'string') {
      if (p.raw.length > MAX_INLINE_FILE_BASE64_CHARS) {
        return { ok: false, error: `inline file bytes ("raw") exceed the ${MAX_INLINE_FILE_BYTES} byte limit — use a URL-referenced file ("url") for larger content` }
      }
      if (!blobStore) {
        return {
          ok: false,
          error: 'inline file bytes ("raw") require a blob store to be configured — see docs/store.md, or send a URL-referenced file ("url") instead',
        }
      }
      const mimeType = typeof p.mediaType === 'string' ? p.mediaType : undefined
      const { url } = await blobStore.put(Buffer.from(p.raw, 'base64'), mimeType ? { mimeType } : {})
      parts.push({
        kind: 'file',
        uri: url,
        ...(mimeType ? { mimeType } : {}),
        ...(typeof p.filename === 'string' ? { name: p.filename } : {}),
      })
    } else {
      return { ok: false, error: 'unsupported part — only parts with a "text", "data", "url", or "raw" field are accepted' }
    }
  }

  let input: unknown
  if (parts.every((p) => p.kind === 'text')) {
    input = parts.map((p) => (p as { kind: 'text'; text: string }).text).join('\n')
  } else if (parts.length === 1 && parts[0]!.kind === 'data') {
    input = (parts[0] as { kind: 'data'; data: Record<string, unknown> }).data
  } else if (parts.length === 1 && parts[0]!.kind === 'file') {
    input = fileTag(parts[0] as Extract<ResolvedPart, { kind: 'file' }>)
  } else {
    input = parts.map((p) => (p.kind === 'text' ? { text: p.text } : p.kind === 'data' ? { data: p.data } : { file: fileTag(p) }))
  }
  return { ok: true, input, ...(message.contextId ? { contextId: message.contextId } : {}) }
}
