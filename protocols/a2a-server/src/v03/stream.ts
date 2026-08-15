import type { BreadCrumb } from '@bread/core'
import { isFileOutput } from '@bread/core'
import { v7 as uuidv7 } from 'uuid'
import { jsonRpcError } from '../jsonrpc.js'
import { formatJsonRpcSseEvent, toClientError } from '../sse.js'
import type { A2ABread } from '../agent-meta.js'
import { extractInput, toOutputFilePart } from './message.js'

function buildErrorMessage(err: unknown, contextId: string | undefined) {
  const { code, message } = toClientError(err)
  return {
    messageId: uuidv7(),
    role: 'agent',
    kind: 'message',
    parts: [{ kind: 'text', text: `${code}: ${message}` }],
    ...(contextId ? { contextId } : {}),
  }
}

// Mutable per-task state threaded through crumbToEventV03 — shared by a
// fresh bread.run() stream (runToA2AEventsV03) and a tasks/resubscribe
// replay-then-live-tail over an existing run's crumb log (v03/tasks.ts),
// so both routes map crumb → A2A event identically.
export interface CrumbEventState {
  taskId: string
  artifactId: string
  artifactOpened: boolean
}

// Pure crumb → A2A event mapping. Returns null for crumb types this
// text-only implementation doesn't surface (tool:call/result/error,
// reasoning:delta, ...).
export function crumbToEventV03(
  crumb: BreadCrumb,
  state: CrumbEventState,
  contextId: string | undefined,
): { result: unknown; seq?: number | undefined } | null {
  const ctxId = () => contextId ?? state.taskId

  if (crumb.type === 'agent:run:start') {
    state.taskId = crumb.runId
    return { seq: crumb.seq, result: { kind: 'task', id: state.taskId, contextId: ctxId(), status: { state: 'working' } } }
  }
  if (crumb.type === 'text:delta') {
    // artifactId is seeded from taskId (not crypto.randomUUID()) so a
    // reconnecting tasks/resubscribe client sees the same artifactId for
    // the same run's output across connections.
    if (!state.artifactId) state.artifactId = state.taskId
    const result = {
      kind: 'artifact-update',
      taskId: state.taskId,
      contextId: ctxId(),
      artifact: { artifactId: state.artifactId, parts: [{ kind: 'text', text: crumb.delta }] },
      append: state.artifactOpened,
      // ponytail: never true — marking the true last chunk needs a
      // one-crumb lookahead we don't need, since the terminal
      // status-update's final:true already tells clients the stream
      // is done. Add lookahead if a client strictly requires
      // lastChunk:true per artifact.
      lastChunk: false,
    }
    state.artifactOpened = true
    return { seq: crumb.seq, result }
  }
  if (crumb.type === 'file:generated') {
    if (!state.artifactId) state.artifactId = state.taskId
    const result = {
      kind: 'artifact-update',
      taskId: state.taskId,
      contextId: ctxId(),
      artifact: {
        artifactId: state.artifactId,
        parts: [toOutputFilePart({ kind: 'file', uri: crumb.uri, mimeType: crumb.mimeType })],
      },
      append: state.artifactOpened,
      lastChunk: false,
    }
    state.artifactOpened = true
    return { seq: crumb.seq, result }
  }
  if (crumb.type === 'agent:run:end') {
    return {
      seq: crumb.seq,
      result: { kind: 'status-update', taskId: state.taskId, contextId: ctxId(), status: { state: 'completed' }, final: true },
    }
  }
  if (crumb.type === 'agent:error') {
    const id = state.taskId || crumb.runId || uuidv7()
    const cancelled = crumb.error.code === 'RUN_CANCELLED'
    return {
      seq: crumb.seq,
      result: {
        kind: 'status-update',
        taskId: id,
        contextId: contextId ?? id,
        status: { state: cancelled ? 'canceled' : 'failed', message: buildErrorMessage(crumb.error, contextId) },
        final: true,
      },
    }
  }
  // tool:call / tool:result / tool:error / reasoning:delta / anything
  // else: skipped — same text-only scope the sync handlers already have.
  return null
}

// Sits next to crumbToEventV03 — the only crumb type that can produce a *second* A2A
// event (a tool-generated file the agent echoed as its own final output, alongside the
// status-update crumbToEventV03 already emits for agent:run:end). Everything else stays
// a single event via crumbToEventV03 itself; model-generated files stream live via the
// file:generated branch above instead, so the two paths never double-emit.
export function agentOutputFileEvent(
  crumb: BreadCrumb,
  state: CrumbEventState,
  contextId: string | undefined,
): { result: unknown; seq?: number | undefined } | null {
  if (crumb.type !== 'agent:run:end' || !isFileOutput(crumb.output)) return null
  if (!state.artifactId) state.artifactId = state.taskId
  const result = {
    kind: 'artifact-update',
    taskId: state.taskId,
    contextId: contextId ?? state.taskId,
    artifact: { artifactId: state.artifactId, parts: [toOutputFilePart(crumb.output)] },
    append: state.artifactOpened,
    lastChunk: false,
  }
  state.artifactOpened = true
  return { seq: crumb.seq, result }
}

async function* runToA2AEventsV03(
  bread: A2ABread,
  agentId: string,
  input: unknown,
  contextId: string | undefined,
  cancelRegistry: Map<string, AbortController>,
): AsyncGenerator<{ result: unknown; seq?: number | undefined }> {
  const state: CrumbEventState = { taskId: '', artifactId: '', artifactOpened: false }
  const abort = new AbortController()

  try {
    // bread.run() is called here, inside the try — some BreadInstance calls
    // throw synchronously (concurrency limit, not-started) rather than
    // rejecting lazily on first iteration, same gotcha as
    // transports/http-sse's runToSseEvents.
    for await (const crumb of bread.run(agentId, input, {
      mode: 'stream',
      signal: abort.signal,
    }) as AsyncIterable<BreadCrumb>) {
      // Register the moment the runId is known — same moment CrumbEventState
      // itself learns it (crumbToEventV03's own agent:run:start branch).
      if (crumb.type === 'agent:run:start') cancelRegistry.set(crumb.runId, abort)
      const fileEvent = agentOutputFileEvent(crumb, state, contextId)
      if (fileEvent) yield fileEvent
      const event = crumbToEventV03(crumb, state, contextId)
      if (event) yield event
    }
  } catch (err) {
    const id = state.taskId || uuidv7()
    // continueRun (@bread/core) yields the agent:error crumb (already mapped
    // to 'canceled'/'failed' above by crumbToEventV03) and *then* throws, so
    // this catch's own status-update must agree with that mapping rather
    // than always saying 'failed' — otherwise a cancelled run's terminal
    // event here would contradict the one crumbToEventV03 already yielded.
    const cancelled = toClientError(err).code === 'RUN_CANCELLED'
    yield {
      result: {
        kind: 'status-update',
        taskId: id,
        contextId: contextId ?? id,
        status: { state: cancelled ? 'canceled' : 'failed', message: buildErrorMessage(err, contextId) },
        final: true,
      },
    }
  } finally {
    if (state.taskId) cancelRegistry.delete(state.taskId)
  }
}

export async function handleStreamRequestV03(
  bread: A2ABread,
  agentId: string,
  id: unknown,
  params: unknown,
  cancelRegistry: Map<string, AbortController>,
): Promise<Response> {
  const extracted = await extractInput(params, bread.blobStore)
  if (!extracted.ok) return jsonRpcError(id, -32602, extracted.error)

  const body = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      try {
        for await (const { result, seq } of runToA2AEventsV03(
          bread,
          agentId,
          extracted.input,
          extracted.contextId,
          cancelRegistry,
        )) {
          controller.enqueue(encoder.encode(formatJsonRpcSseEvent(id, result, seq)))
        }
      } finally {
        controller.close()
      }
    },
  })
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  })
}
