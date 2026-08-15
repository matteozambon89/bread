import type { BreadCrumb } from '@bread/core'
import { BreadError } from '@bread/core'

// Today's SSE wire format, relocated verbatim (wire-compatible, not a
// redesign) from packages/server/src/server.ts: `data: {type,payload}\n\n`,
// `id: <seq>` for Last-Event-ID recovery. Existing curl/EventSource examples
// keep working unchanged.

export interface SseEvent {
  type: string
  payload?: unknown
  id?: number | undefined
}

export function writeSseEvent(s: { write(str: string): Promise<unknown> }, event: SseEvent): Promise<unknown> {
  const frame = event.id !== undefined ? `id: ${event.id}\n` : ''
  return s.write(`${frame}data: ${JSON.stringify({ type: event.type, payload: event.payload })}\n\n`)
}

// What an HTTP client may see of an error: code + message only. Stack, cause,
// and context stay server-side.
export function toClientError(err: unknown): { code: string; message: string } {
  if (err instanceof BreadError) return { code: err.code, message: err.message }
  if (err instanceof AggregateError) {
    return { code: 'AGGREGATE_ERROR', message: err.message || 'Multiple operations failed' }
  }
  return { code: 'INTERNAL_ERROR', message: 'Internal server error' }
}

// Error-carrying crumbs hold a full BreadError (cause, context, stack);
// clients get the sanitized shape, the rich error stays in-process.
export function toSseEvent(crumb: BreadCrumb): SseEvent {
  const payload =
    crumb.type === 'agent:error' || crumb.type === 'tool:error'
      ? { ...crumb, error: toClientError((crumb as { error: unknown }).error) }
      : crumb
  return { type: crumb.type, payload, id: crumb.seq }
}
