// A minimal, independent storage seam for binary content — separate from
// BreadStore because a blob backend (S3, ...) can't reasonably implement
// BreadStore's required session/checkpoint/loop contract, the same way
// BreadTransport is its own seam rather than a BreadStore method group.
//
// Concrete implementations live in their own packages (@breadai/store-s3, ...).
export interface BlobStore {
  // Stores `data` and returns a generated key plus a retrievable URL — bread
  // never hands the caller a key to invent (mirrors BreadStore.ingestDocument
  // generating its own id). No delete()/migrate()/close() yet — nothing
  // currently needs blob lifecycle management; add when something does.
  put(data: Uint8Array, opts?: { mimeType?: string }): Promise<{ key: string; url: string }>
  get(key: string): Promise<{ data: Uint8Array; mimeType?: string } | undefined>
}

// A pointer to a blob an agent hands back as (part of) its own output — either a tool
// that called BlobStore.put() itself and echoed the reference through the agent's
// structured output, or a model-generated file the runner stored automatically (see
// FileGeneratedCrumb). Matches a2a-server's own existing canonical FilePart shape 1:1.
export interface FileOutput {
  kind: 'file'
  uri: string
  mimeType?: string
  name?: string
}

export function isFileOutput(value: unknown): value is FileOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'file' &&
    typeof (value as { uri?: unknown }).uri === 'string'
  )
}
