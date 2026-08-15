import { BreadError } from '@bread/core'

// Every A2A streaming event (v0.3's message/stream or v1.0's
// SendStreamingMessage) rides as a full JSON-RPC 2.0 envelope in the SSE
// `data:` line — not a bare event — for both spec versions, since both are
// JSON-RPC bindings (v1.0's REST/gRPC bindings are out of scope).
export function formatJsonRpcSseEvent(id: unknown, result: unknown, seq?: number): string {
  const frame = seq !== undefined ? `id: ${seq}\n` : ''
  return `${frame}data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`
}

// What a streaming client may see of a failed run: code + message only.
// Duplicated (not imported) from transports/http-sse/src/sse.ts: pulling in
// a sibling transport package as a dependency for six lines is the wrong
// trade — a2a-server deliberately has no runtime deps beyond @bread/core.
export function toClientError(err: unknown): { code: string; message: string } {
  if (err instanceof BreadError) return { code: err.code, message: err.message }
  if (err instanceof AggregateError) {
    return { code: 'AGGREGATE_ERROR', message: err.message || 'Multiple operations failed' }
  }
  return { code: 'INTERNAL_ERROR', message: 'Internal server error' }
}
