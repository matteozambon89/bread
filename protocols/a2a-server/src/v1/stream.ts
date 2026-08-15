import type { BreadCrumb } from '@breadai/core'
import { isFileOutput } from '@breadai/core'
import { v7 as uuidv7 } from 'uuid'
import { jsonRpcError } from '../jsonrpc.js'
import { formatJsonRpcSseEvent, toClientError } from '../sse.js'
import type { A2ABread } from '../agent-meta.js'
import { extractInput, toOutputFilePart } from './message.js'

function buildErrorMessage(err: unknown, contextId: string | undefined) {
  const { code, message } = toClientError(err)
  return {
    messageId: uuidv7(),
    role: 'ROLE_AGENT',
    parts: [{ text: `${code}: ${message}` }],
    ...(contextId ? { contextId } : {}),
  }
}

// Mutable per-task state threaded through crumbToEventV1 — shared by a
// fresh bread.run() stream (runToA2AEventsV1) and a SubscribeToTask replay-
// then-live-tail over an existing run's crumb log (v1/tasks.ts), so both
// routes map crumb → A2A event identically.
export interface CrumbEventState {
  taskId: string
  artifactId: string
  artifactOpened: boolean
}

// Same crumb → event mapping as v03/stream.ts, v1.0-flavored wire shape:
// oneof-by-key instead of `kind`, TASK_STATE_* enum strings.
export function crumbToEventV1(
  crumb: BreadCrumb,
  state: CrumbEventState,
  contextId: string | undefined,
): { result: unknown; seq?: number | undefined } | null {
  const ctxId = () => contextId ?? state.taskId

  if (crumb.type === 'agent:run:start') {
    state.taskId = crumb.runId
    return { seq: crumb.seq, result: { task: { id: state.taskId, contextId: ctxId(), status: { state: 'TASK_STATE_WORKING' } } } }
  }
  if (crumb.type === 'text:delta') {
    // artifactId is seeded from taskId (not crypto.randomUUID()) so a
    // reconnecting SubscribeToTask client sees the same artifactId for the
    // same run's output across connections.
    if (!state.artifactId) state.artifactId = state.taskId
    const result = {
      artifactUpdate: {
        taskId: state.taskId,
        contextId: ctxId(),
        artifact: { artifactId: state.artifactId, parts: [{ text: crumb.delta }] },
        append: state.artifactOpened,
        // ponytail: see v03/stream.ts's identical note — the terminal
        // statusUpdate's final:true is the real end-of-stream signal.
        lastChunk: false,
      },
    }
    state.artifactOpened = true
    return { seq: crumb.seq, result }
  }
  if (crumb.type === 'file:generated') {
    if (!state.artifactId) state.artifactId = state.taskId
    const result = {
      artifactUpdate: {
        taskId: state.taskId,
        contextId: ctxId(),
        artifact: {
          artifactId: state.artifactId,
          parts: [toOutputFilePart({ kind: 'file', uri: crumb.uri, mimeType: crumb.mimeType })],
        },
        append: state.artifactOpened,
        lastChunk: false,
      },
    }
    state.artifactOpened = true
    return { seq: crumb.seq, result }
  }
  if (crumb.type === 'agent:run:end') {
    return {
      seq: crumb.seq,
      result: { statusUpdate: { taskId: state.taskId, contextId: ctxId(), status: { state: 'TASK_STATE_COMPLETED' }, final: true } },
    }
  }
  if (crumb.type === 'agent:error') {
    const id = state.taskId || crumb.runId || uuidv7()
    const cancelled = crumb.error.code === 'RUN_CANCELLED'
    return {
      seq: crumb.seq,
      result: {
        statusUpdate: {
          taskId: id,
          contextId: contextId ?? id,
          status: {
            state: cancelled ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED',
            message: buildErrorMessage(crumb.error, contextId),
          },
          final: true,
        },
      },
    }
  }
  // tool:call / tool:result / tool:error / reasoning:delta / anything
  // else: skipped — same text-only scope the sync handlers already have.
  return null
}

// Sits next to crumbToEventV1 — see v03/stream.ts's identical helper for the rationale
// (the only crumb type that can produce a second A2A event: a tool-generated file the
// agent echoed as its own final output).
export function agentOutputFileEvent(
  crumb: BreadCrumb,
  state: CrumbEventState,
  contextId: string | undefined,
): { result: unknown; seq?: number | undefined } | null {
  if (crumb.type !== 'agent:run:end' || !isFileOutput(crumb.output)) return null
  if (!state.artifactId) state.artifactId = state.taskId
  const result = {
    artifactUpdate: {
      taskId: state.taskId,
      contextId: contextId ?? state.taskId,
      artifact: { artifactId: state.artifactId, parts: [toOutputFilePart(crumb.output)] },
      append: state.artifactOpened,
      lastChunk: false,
    },
  }
  state.artifactOpened = true
  return { seq: crumb.seq, result }
}

async function* runToA2AEventsV1(
  bread: A2ABread,
  agentId: string,
  input: unknown,
  contextId: string | undefined,
  cancelRegistry: Map<string, AbortController>,
): AsyncGenerator<{ result: unknown; seq?: number | undefined }> {
  const state: CrumbEventState = { taskId: '', artifactId: '', artifactOpened: false }
  const abort = new AbortController()

  try {
    for await (const crumb of bread.run(agentId, input, {
      mode: 'stream',
      signal: abort.signal,
    }) as AsyncIterable<BreadCrumb>) {
      if (crumb.type === 'agent:run:start') cancelRegistry.set(crumb.runId, abort)
      const fileEvent = agentOutputFileEvent(crumb, state, contextId)
      if (fileEvent) yield fileEvent
      const event = crumbToEventV1(crumb, state, contextId)
      if (event) yield event
    }
  } catch (err) {
    const id = state.taskId || uuidv7()
    // continueRun (@breadai/core) yields the agent:error crumb (already mapped
    // to TASK_STATE_CANCELED/TASK_STATE_FAILED above by crumbToEventV1) and
    // *then* throws, so this catch's own statusUpdate must agree with that
    // mapping rather than always saying FAILED.
    const cancelled = toClientError(err).code === 'RUN_CANCELLED'
    yield {
      result: {
        statusUpdate: {
          taskId: id,
          contextId: contextId ?? id,
          status: {
            state: cancelled ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED',
            message: buildErrorMessage(err, contextId),
          },
          final: true,
        },
      },
    }
  } finally {
    if (state.taskId) cancelRegistry.delete(state.taskId)
  }
}

export async function handleStreamRequestV1(
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
        for await (const { result, seq } of runToA2AEventsV1(
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
