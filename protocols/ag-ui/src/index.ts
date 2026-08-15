import { isFileOutput } from '@bread/core'
import type { AuthIdentity, BreadCrumb, BreadInstance, BreadInstanceRef, BreadPlugin } from '@bread/core'

// AG-UI protocol events (https://ag-ui.com), spec field names: `messageId`/
// `delta` for text framing, `toolCallName` for tools, `threadId` = bread's
// sessionId, RUN_ERROR (not ERROR) for failures.
export type AgUiEvent =
  | { type: 'RUN_STARTED'; timestamp: number; threadId: string; runId: string }
  | { type: 'RUN_FINISHED'; timestamp: number; threadId: string; runId: string; result?: unknown }
  | { type: 'RUN_ERROR'; timestamp: number; message: string; code?: string }
  | { type: 'TEXT_MESSAGE_START'; timestamp: number; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; timestamp: number; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; timestamp: number; messageId: string }
  | {
      type: 'TOOL_CALL_START'
      timestamp: number
      toolCallId: string
      toolCallName: string
      parentMessageId?: string
    }
  | { type: 'TOOL_CALL_ARGS'; timestamp: number; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; timestamp: number; toolCallId: string }
  | { type: 'TOOL_CALL_RESULT'; timestamp: number; messageId: string; toolCallId: string; content: string }
  | { type: 'STEP_STARTED'; timestamp: number; stepName: string }
  | { type: 'STEP_FINISHED'; timestamp: number; stepName: string }
  | { type: 'STATE_SNAPSHOT'; timestamp: number; snapshot: unknown }
  // The AG-UI spec's own general-purpose extensibility event (EventType.CUSTOM) — used here
  // only for FILE_GENERATED (a model-generated or tool-echoed file), the same shape regardless
  // of which of the two produced it.
  | { type: 'CUSTOM'; timestamp: number; name: string; value: unknown }

export type AgUiEventHandler = (event: AgUiEvent) => void

export interface AgUiOptions {
  onEvent?: AgUiEventHandler
  // The bread agent this plugin exposes an AG-UI HTTP ingress route for. Omit
  // to use agUi() purely as a crumb→event mapper (no route registered) — the
  // same one-plugin-one-agent shape a2aServer() uses, for the same reason:
  // routes() needs to know which agent a POSTed RunAgentInput invokes.
  agentId?: string
  // HTTP path for the RunAgentInput POST route. Defaults to '/ag-ui/run'
  // (the spec has no fixed convention; root '/' risks colliding with another
  // plugin's route on the shared Hono app). Only used when agentId is set.
  path?: string
  // Opt-in authorization binding a client-supplied threadId to the caller's
  // identity. Absent, `threadId` is used directly as bread's sessionId with
  // no ownership check at all — any caller who knows or guesses a threadId
  // can read/write that session's history. Identity comes from whatever
  // authMiddleware/authPlugin stashed via c.set('identity') — same opt-in
  // shape as transport-http-chunked's authorizeStream.
  authorizeThread?(identity: AuthIdentity | undefined, threadId: string): Promise<boolean> | boolean
}

// Minimal RunAgentInput shape (https://docs.ag-ui.com/concepts/messages),
// confirmed against the real SDK schema (sdks/typescript/packages/core/src/types.ts):
// threadId/runId/state/messages/tools/context/forwardedProps, `resume` optional.
// Only the fields this ingress actually consumes are typed strictly; the rest
// pass through opaque since bread has no use for them yet (no tool-calling-back-
// to-the-frontend or state-diffing support on this side).
export interface RunAgentInputMessage {
  id?: string
  role: string
  content?: string
}

export interface RunAgentInput {
  threadId: string
  runId?: string
  parentRunId?: string
  state?: unknown
  messages: RunAgentInputMessage[]
  tools?: unknown[]
  context?: unknown[]
  forwardedProps?: unknown
  resume?: unknown[]
}

type ParsedRunAgentInput = { ok: true; threadId: string; content: string } | { ok: false; error: string }

// Only the last message's content becomes this turn's bread `input` — bread's
// own session store (keyed by threadId below) accumulates history server-side,
// so replaying the client's full resent message array back through the model
// would double up context that's already there. AG-UI clients always append
// the newest message before each run, so "last message" is always the new one.
function parseRunAgentInput(body: unknown): ParsedRunAgentInput {
  const b = body as Partial<RunAgentInput> | null
  if (!b || typeof b !== 'object') return { ok: false, error: 'request body must be a JSON object' }
  if (typeof b.threadId !== 'string' || !b.threadId) return { ok: false, error: '"threadId" is required and must be a string' }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { ok: false, error: '"messages" must be a non-empty array' }
  }
  const last = b.messages[b.messages.length - 1] as { content?: unknown } | undefined
  if (typeof last?.content !== 'string') {
    return { ok: false, error: 'the last message must have string "content" — non-text messages are not supported yet' }
  }
  return { ok: true, threadId: b.threadId, content: last.content }
}

// The slice of the public BreadInstance the ingress route needs to drive a run.
type AgUiBread = Pick<BreadInstance, 'run'>

// Minimal shape of the Hono app passed to BreadPlugin.routes — avoids a hono
// dep, same pattern a2a-server's MinimalApp uses. `get` is optional/untyped
// (mirrors Hono's Context#get without importing Hono) — only used to read
// back whatever authMiddleware/authPlugin stashed via c.set('identity').
interface MinimalApp {
  post(
    path: string,
    handler: (c: { req: { raw: Request }; get?(key: string): unknown }) => Response | Promise<Response>,
  ): unknown
}

// ponytail: the non-Error fallback is untested — every synchronous throw
// bread.run() can produce is a BreadError (extends Error), so there's no live
// path that reaches it. Kept for defensive completeness against a plugin or
// future core change throwing a bare value.
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Internal server error'
}

interface LoopState {
  loopId: string
  phase: string
  iteration?: number
  maxIterations?: number
  status?: string
  result?: unknown
}

/**
 * A stateful crumb→AG-UI mapper. Statefulness is what produces correct
 * TEXT_MESSAGE_START/END framing: an assistant message opens on the first
 * `text:delta` of a run and closes at the next tool call, run end, error, or
 * HITL suspension — spec-conformant clients key their rendering on it.
 */
export function createAgUiTransformer(): (crumb: BreadCrumb) => AgUiEvent[] {
  const openMessages = new Map<string, string>() // runId → open assistant messageId
  const loops = new Map<string, LoopState>() // loopId → last-known state
  // toolCallIds whose args were streamed via tool:input:*, so the later
  // tool:call crumb (always emitted, streamed or not) knows to skip
  // re-emitting TOOL_CALL_START/ARGS/END for them.
  const streamingToolCalls = new Set<string>()
  let seq = 0

  function closeMessage(runId: string, ts: number, out: AgUiEvent[]): string | undefined {
    const messageId = openMessages.get(runId)
    if (!messageId) return undefined
    openMessages.delete(runId)
    out.push({ type: 'TEXT_MESSAGE_END', timestamp: ts, messageId })
    return messageId
  }

  function snapshotLoop(loopId: string, ts: number, patch: Partial<LoopState>): AgUiEvent[] {
    const state: LoopState = { ...(loops.get(loopId) ?? { loopId, phase: 'unknown' }), ...patch }
    loops.set(loopId, state)
    return [{ type: 'STATE_SNAPSHOT', timestamp: ts, snapshot: { loop: state } }]
  }

  return (crumb: BreadCrumb): AgUiEvent[] => {
    const ts = crumb.timestamp

    switch (crumb.type) {
      case 'agent:run:start':
        return [{ type: 'RUN_STARTED', timestamp: ts, threadId: crumb.sessionId, runId: crumb.runId }]

      case 'agent:run:end': {
        const out: AgUiEvent[] = []
        closeMessage(crumb.runId, ts, out)
        if (isFileOutput(crumb.output)) {
          out.push({
            type: 'CUSTOM',
            timestamp: ts,
            name: 'FILE_GENERATED',
            value: { uri: crumb.output.uri, mimeType: crumb.output.mimeType, name: crumb.output.name },
          })
        }
        out.push({
          type: 'RUN_FINISHED',
          timestamp: ts,
          threadId: crumb.sessionId,
          runId: crumb.runId,
          result: crumb.output,
        })
        return out
      }

      case 'file:generated':
        return [
          {
            type: 'CUSTOM',
            timestamp: ts,
            name: 'FILE_GENERATED',
            value: { uri: crumb.uri, mimeType: crumb.mimeType, name: crumb.name },
          },
        ]

      case 'agent:error': {
        const out: AgUiEvent[] = []
        if (crumb.runId) closeMessage(crumb.runId, ts, out)
        out.push({ type: 'RUN_ERROR', timestamp: ts, message: crumb.error.message, code: crumb.error.code })
        return out
      }

      case 'text:delta': {
        const out: AgUiEvent[] = []
        let messageId = openMessages.get(crumb.runId)
        if (!messageId) {
          messageId = `${crumb.runId}#${++seq}`
          openMessages.set(crumb.runId, messageId)
          out.push({ type: 'TEXT_MESSAGE_START', timestamp: ts, messageId, role: 'assistant' })
        }
        out.push({ type: 'TEXT_MESSAGE_CONTENT', timestamp: ts, messageId, delta: crumb.delta })
        return out
      }

      case 'tool:input:start': {
        const out: AgUiEvent[] = []
        const parentMessageId = closeMessage(crumb.runId, ts, out)
        streamingToolCalls.add(crumb.toolCallId)
        out.push({
          type: 'TOOL_CALL_START',
          timestamp: ts,
          toolCallId: crumb.toolCallId,
          toolCallName: crumb.toolName,
          ...(parentMessageId ? { parentMessageId } : {}),
        })
        return out
      }

      case 'tool:input:delta':
        return [{ type: 'TOOL_CALL_ARGS', timestamp: ts, toolCallId: crumb.toolCallId, delta: crumb.delta }]

      case 'tool:input:end':
        return [{ type: 'TOOL_CALL_END', timestamp: ts, toolCallId: crumb.toolCallId }]

      case 'tool:call': {
        // Args already streamed via tool:input:* — START/ARGS/END were
        // already emitted for this call, nothing left to do here.
        if (streamingToolCalls.delete(crumb.toolCallId)) return []

        // Fallback for providers that don't stream tool input: bread
        // surfaces complete args in one crumb; AG-UI streams them — one
        // delta carrying the full JSON is the degenerate-but-valid encoding.
        const out: AgUiEvent[] = []
        const parentMessageId = closeMessage(crumb.runId, ts, out)
        out.push({
          type: 'TOOL_CALL_START',
          timestamp: ts,
          toolCallId: crumb.toolCallId,
          toolCallName: crumb.toolName,
          ...(parentMessageId ? { parentMessageId } : {}),
        })
        out.push({
          type: 'TOOL_CALL_ARGS',
          timestamp: ts,
          toolCallId: crumb.toolCallId,
          delta: JSON.stringify(crumb.args ?? {}),
        })
        out.push({ type: 'TOOL_CALL_END', timestamp: ts, toolCallId: crumb.toolCallId })
        return out
      }

      case 'tool:result':
        return [
          {
            type: 'TOOL_CALL_RESULT',
            timestamp: ts,
            messageId: `${crumb.runId}#${++seq}`,
            toolCallId: crumb.toolCallId,
            content: typeof crumb.result === 'string' ? crumb.result : JSON.stringify(crumb.result),
          },
        ]

      case 'tool:error':
        return [
          {
            type: 'TOOL_CALL_RESULT',
            timestamp: ts,
            messageId: `${crumb.runId}#${++seq}`,
            toolCallId: crumb.toolCallId,
            content: JSON.stringify({ error: { code: crumb.error.code, message: crumb.error.message } }),
          },
        ]

      case 'human:required': {
        // The run suspends: close the message so clients don't hold a dangling
        // stream. The suspension itself is bread-specific (no AG-UI event).
        const out: AgUiEvent[] = []
        closeMessage(crumb.runId, ts, out)
        return out
      }

      case 'subagent:run:start':
        return [
          { type: 'STEP_STARTED', timestamp: ts, stepName: `subagent_${crumb.subagentId}` },
          {
            type: 'STATE_SNAPSHOT',
            timestamp: ts,
            snapshot: {
              subagent: { parentAgentId: crumb.parentAgentId, subagentId: crumb.subagentId, status: 'running' },
            },
          },
        ]

      case 'subagent:run:end':
        return [
          { type: 'STEP_FINISHED', timestamp: ts, stepName: `subagent_${crumb.subagentId}` },
          {
            type: 'STATE_SNAPSHOT',
            timestamp: ts,
            snapshot: {
              subagent: {
                parentAgentId: crumb.parentAgentId,
                subagentId: crumb.subagentId,
                status: 'finished',
                output: crumb.output,
              },
            },
          },
        ]

      case 'task:start':
        return [
          { type: 'STEP_STARTED', timestamp: ts, stepName: `task_${crumb.taskRunId}` },
          {
            type: 'STATE_SNAPSHOT',
            timestamp: ts,
            snapshot: {
              task: { taskRunId: crumb.taskRunId, taskId: crumb.taskId, model: crumb.model, status: 'running' },
            },
          },
        ]

      case 'task:end':
        return [
          { type: 'STEP_FINISHED', timestamp: ts, stepName: `task_${crumb.taskRunId}` },
          {
            type: 'STATE_SNAPSHOT',
            timestamp: ts,
            snapshot: {
              task: {
                taskRunId: crumb.taskRunId,
                taskId: crumb.taskId,
                status: crumb.status,
                durationMs: crumb.durationMs,
                usage: crumb.usage,
                error: crumb.error,
              },
            },
          },
        ]

      case 'pipeline:step:start':
        return [{ type: 'STEP_STARTED', timestamp: ts, stepName: `step_${crumb.stepIndex}_${crumb.agentId}` }]

      case 'pipeline:step:end':
        return [{ type: 'STEP_FINISHED', timestamp: ts, stepName: `step_${crumb.stepIndex}_${crumb.agentId}` }]

      case 'loop:start':
        return snapshotLoop(crumb.loopId, ts, {
          loopId: crumb.loopId,
          phase: 'running',
          maxIterations: crumb.maxIterations,
        })

      case 'loop:iteration:start':
        return [
          { type: 'STEP_STARTED', timestamp: ts, stepName: `loop_iteration_${crumb.iteration}` },
          ...snapshotLoop(crumb.loopId, ts, { phase: 'iterating', iteration: crumb.iteration }),
        ]

      case 'loop:iteration:end':
        return [
          { type: 'STEP_FINISHED', timestamp: ts, stepName: `loop_iteration_${crumb.iteration}` },
          ...snapshotLoop(crumb.loopId, ts, { phase: 'iterated', iteration: crumb.iteration }),
        ]

      case 'loop:end':
        return snapshotLoop(crumb.loopId, ts, {
          phase: 'finished',
          status: crumb.status,
          result: crumb.result,
        })

      default:
        return []
    }
  }
}

export function agUi(opts: AgUiOptions = {}): BreadPlugin {
  const transform = createAgUiTransformer()
  let breadRef: AgUiBread | null = null

  return {
    name: 'ag_ui',

    async init(bread: BreadInstanceRef) {
      breadRef = bread as unknown as AgUiBread
      bread.on('crumb', (crumb: BreadCrumb) => {
        for (const event of transform(crumb)) {
          opts.onEvent?.(event)
        }
      })
    },

    routes(app: unknown) {
      if (!opts.agentId) return
      const agentId = opts.agentId
      const path = opts.path ?? '/ag-ui/run'

      ;(app as MinimalApp).post(path, async (c) => {
        if (!breadRef) return new Response('bread not started', { status: 503 })

        let body: unknown
        try {
          body = await c.req.raw.json()
        } catch {
          return Response.json({ error: 'request body must be valid JSON' }, { status: 400 })
        }
        const parsed = parseRunAgentInput(body)
        if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })

        if (opts.authorizeThread) {
          const identity = c.get?.('identity') as AuthIdentity | undefined
          if (!(await opts.authorizeThread(identity, parsed.threadId))) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
        }

        const bread = breadRef
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder()
            const send = (event: AgUiEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            // A dedicated transformer per request, not the plugin-level
            // `transform` above — that one is already fed independently by
            // the global bread.on('crumb') listener in init(), so reusing it
            // here would run every crumb through the (stateful) mapper twice
            // and desync its open-message tracking. This route already gets
            // this run's own crumb stream directly from bread.run() below.
            const requestTransform = createAgUiTransformer()
            // A run's own agent:error crumb already maps to a RUN_ERROR event
            // below (in the loop, via `requestTransform`) before the generator
            // throws on its *next* iteration (runner.ts: `yield errCrumb; throw
            // finalErr` — the crumb is always delivered first) — the catch
            // below must not re-synthesize a second RUN_ERROR for that same
            // failure. It only needs to cover a failure with no crumb at all
            // (e.g. bread.run() throwing synchronously — concurrency limit,
            // agent not started — before the loop ever runs).
            let terminalCrumbSeen = false
            try {
              // bread.run() is called here, inside the try — some
              // BreadInstance calls throw synchronously rather than rejecting
              // lazily on first iteration, same gotcha a2a-server's
              // runToA2AEventsV03 and transport-http-sse's runToSseEvents note.
              for await (const crumb of bread.run(agentId, parsed.content, {
                mode: 'stream',
                session: { id: parsed.threadId },
              }) as AsyncIterable<BreadCrumb>) {
                if (crumb.type === 'agent:error' || crumb.type === 'agent:run:end') terminalCrumbSeen = true
                for (const event of requestTransform(crumb)) send(event)
              }
            } catch (err) {
              if (!terminalCrumbSeen) {
                send({ type: 'RUN_ERROR', timestamp: Date.now(), message: errorMessage(err) })
              }
            } finally {
              controller.close()
            }
          },
        })
        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
        })
      })
    },
  }
}
