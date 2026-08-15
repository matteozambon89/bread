import type { BreadCrumb, BusFrame, CrumbLogEntry } from '@bread/core'
import { fromWireCrumb } from '@bread/core'
import { jsonRpcError, jsonRpcResult } from '../jsonrpc.js'
import { formatJsonRpcSseEvent } from '../sse.js'
import type { A2ABread } from '../agent-meta.js'
import { deriveTaskStatus, extractTaskId, isTerminalTaskStatus } from '../task-status.js'
import { agentOutputFileEvent, type CrumbEventState, crumbToEventV03 } from './stream.js'

const HEARTBEAT_MS = 15_000
const isTerminalCrumbType = (type: string) => type === 'agent:run:end' || type === 'agent:error'

// Loads a task's crumb log, applying the same ownership/redaction policy
// both handlers below need before they can trust it. Returns 'not-found'
// entries as an empty array — callers just check status/length.
async function loadTaskEntries(bread: A2ABread, agentId: string, taskId: string): Promise<CrumbLogEntry[]> {
  if (!bread.store.getCrumbs) return []
  let entries = await bread.store.getCrumbs(taskId)
  if (bread.crumbFilter) {
    const filter = bread.crumbFilter
    entries = entries.filter((entry) => filter(fromWireCrumb(entry.crumb as BreadCrumb)))
  }
  // Defense-in-depth: one a2aServer(...) mount shouldn't leak another
  // agent's task status by taskId-guessing.
  if (entries.length > 0 && entries[0]!.agentId !== agentId) return []
  return entries
}

export async function handleTasksGetV03(bread: A2ABread, agentId: string, id: unknown, params: unknown): Promise<Response> {
  const taskId = extractTaskId(params)
  if (!taskId) return jsonRpcError(id, -32602, 'params.id must be a string')

  const entries = await loadTaskEntries(bread, agentId, taskId)
  const status = deriveTaskStatus(entries)
  if (status === 'not-found') return jsonRpcError(id, -32001, 'Task not found')

  // historyLength (params) is accepted but ignored — this implementation
  // returns status only, no artifacts/history array.
  return jsonRpcResult(id, { id: taskId, contextId: taskId, status: { state: status } })
}

// Cancellation only ever works for a task started via this a2aServer
// instance's own message/stream — a synchronous message/send never exposes
// its runId to the caller until the run has already finished, so there is
// no window for an external client to learn it while still cancelable.
// Optimistic response (spec-sanctioned: "success is not guaranteed") — no
// re-derive-and-wait for the crumb log to catch up with the abort.
export async function handleTasksCancelV03(
  bread: A2ABread,
  agentId: string,
  id: unknown,
  params: unknown,
  cancelRegistry: Map<string, AbortController>,
): Promise<Response> {
  const taskId = extractTaskId(params)
  if (!taskId) return jsonRpcError(id, -32602, 'params.id must be a string')

  const entries = await loadTaskEntries(bread, agentId, taskId)
  const status = deriveTaskStatus(entries)
  if (status === 'not-found') return jsonRpcError(id, -32001, 'Task not found')
  if (isTerminalTaskStatus(status)) return jsonRpcError(id, -32002, 'Task is not in a cancelable state')

  const controller = cancelRegistry.get(taskId)
  if (!controller) return jsonRpcError(id, -32002, 'Task is not in a cancelable state')

  controller.abort()
  cancelRegistry.delete(taskId)

  // Same minimal Task shape tasks/get returns — state only, no message
  // (this codebase's `message` field is always a full A2A Message object,
  // per buildErrorMessage, and there's nothing structured to say here).
  return jsonRpcResult(id, { id: taskId, contextId: taskId, status: { state: 'canceled' } })
}

async function* resubscribeToA2AEventsV03(
  bread: A2ABread,
  taskId: string,
  entries: CrumbLogEntry[],
  after: number,
  signal: AbortSignal,
): AsyncGenerator<{ kind: 'event'; result: unknown; seq?: number | undefined } | { kind: 'ping' }> {
  const state: CrumbEventState = {
    taskId,
    artifactId: taskId,
    artifactOpened: entries.some((entry) => entry.seq <= after && entry.type === 'text:delta'),
  }

  let replayedMax = after
  let terminal = !bread.transport.subscribe
  for (const entry of entries) {
    if (entry.seq <= after) continue
    const crumb = fromWireCrumb(entry.crumb as BreadCrumb)
    const fileEvent = agentOutputFileEvent(crumb, state, undefined)
    if (fileEvent) yield { kind: 'event', ...fileEvent }
    const event = crumbToEventV03(crumb, state, undefined)
    if (event) yield { kind: 'event', ...event }
    replayedMax = Math.max(replayedMax, entry.seq)
    if (isTerminalCrumbType(entry.type)) terminal = true
  }
  if (terminal || !bread.transport.subscribe) return

  const pending: BusFrame[] = []
  let wake: (() => void) | null = null
  const unsub = bread.transport.subscribe(taskId, Number.MAX_SAFE_INTEGER, (frame) => {
    pending.push(frame)
    wake?.()
    wake = null
  })
  // Wake the heartbeat wait immediately on client disconnect — otherwise
  // signal.aborted only gets rechecked when the next frame or heartbeat
  // timer fires (up to HEARTBEAT_MS later), leaving the subscription (and
  // the underlying connection, per Bun.serve's idle timeout) alive longer
  // than necessary after the client is already gone.
  signal.addEventListener('abort', () => {
    wake?.()
    wake = null
  })
  try {
    while (!terminal && !signal.aborted) {
      while (pending.length > 0) {
        const frame = pending.shift()!
        const isDelta = frame.crumb.type === 'text:delta' || frame.crumb.type === 'reasoning:delta'
        if (isDelta ? frame.seq < replayedMax : frame.seq <= replayedMax) continue
        if (!isDelta) replayedMax = frame.seq
        const crumb = fromWireCrumb(frame.crumb)
        const fileEvent = agentOutputFileEvent(crumb, state, undefined)
        if (fileEvent) yield { kind: 'event', ...fileEvent }
        const event = crumbToEventV03(crumb, state, undefined)
        if (event) yield { kind: 'event', ...event }
        if (isTerminalCrumbType(frame.crumb.type)) {
          terminal = true
          break
        }
      }
      if (terminal || signal.aborted) break

      const gotFrame = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve(false)
        }, HEARTBEAT_MS)
        timer.unref?.()
        wake = () => {
          clearTimeout(timer)
          resolve(true)
        }
      })
      if (!gotFrame && !signal.aborted) yield { kind: 'ping' }
    }
  } finally {
    unsub()
  }
}

export async function handleTasksResubscribeV03(
  bread: A2ABread,
  agentId: string,
  id: unknown,
  params: unknown,
  req: Request,
): Promise<Response> {
  const taskId = extractTaskId(params)
  if (!taskId) return jsonRpcError(id, -32602, 'params.id must be a string')

  const entries = await loadTaskEntries(bread, agentId, taskId)
  const status = deriveTaskStatus(entries)
  if (status === 'not-found') return jsonRpcError(id, -32001, 'Task not found')
  if (isTerminalTaskStatus(status)) {
    return jsonRpcError(id, -32004, 'Task is no longer active — cannot resubscribe')
  }

  const rawAfter = req.headers.get('Last-Event-ID') ?? new URL(req.url).searchParams.get('after') ?? '0'
  const after = Number(rawAfter)
  if (!Number.isFinite(after) || after < 0) return jsonRpcError(id, -32602, `Invalid Last-Event-ID / after: "${rawAfter}"`)

  const controller = new AbortController()
  const body = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder()
      // Flush a comment line immediately — a replay with nothing mapped to
      // an A2A event (e.g. reconnecting right after a human:required with
      // no live activity yet) would otherwise enqueue nothing until the
      // next real event or the heartbeat, leaving the client with no
      // response bytes — not even headers — for up to HEARTBEAT_MS. Same
      // fix as transport-http-sse's passive route writing its `retry:`
      // line first thing.
      streamController.enqueue(encoder.encode(': connected\n\n'))
      try {
        for await (const evt of resubscribeToA2AEventsV03(bread, taskId, entries, after, controller.signal)) {
          const chunk = evt.kind === 'ping' ? ': ping\n\n' : formatJsonRpcSseEvent(id, evt.result, evt.seq)
          streamController.enqueue(encoder.encode(chunk))
        }
      } finally {
        streamController.close()
      }
    },
    cancel() {
      controller.abort()
    },
  })
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  })
}
