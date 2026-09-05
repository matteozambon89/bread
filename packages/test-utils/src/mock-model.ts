import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'

type StreamResult = ReturnType<typeof streamOf>
type StreamFactory = () => StreamResult

// Returns an async `doStream` that yields each step's stream once, in order (the
// last repeats if called again). Each step is a *factory* so every call builds a
// FRESH ReadableStream — a stream is single-use, so a model reused across runs
// (map fanout, loop iterations) must not hand back an already-drained one.
// (A bare array can't be used either: MockLanguageModelV4 records the call
// before indexing, so an array would skip the first entry.)
function sequence(...factories: StreamFactory[]): () => Promise<StreamResult> {
  let i = 0
  return async () => factories[Math.min(i++, factories.length - 1)]!()
}

// A zero-token usage record in the AI SDK provider shape. Tests assert on
// bread crumbs, never on token accounting, so the exact numbers are irrelevant —
// they just have to type-check.
const noUsage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
}

type FinishReason = LanguageModelV4StreamPart extends infer P
  ? P extends { type: 'finish'; finishReason: infer R }
    ? R
    : never
  : never

const stop: FinishReason = { unified: 'stop', raw: undefined }
const toolCalls: FinishReason = { unified: 'tool-calls', raw: undefined }

function streamOf(chunks: LanguageModelV4StreamPart[], chunkDelayInMs = 0) {
  return { stream: simulateReadableStream({ chunks, chunkDelayInMs, initialDelayInMs: 0 }) }
}

function textStream(text: string): StreamResult {
  return streamOf([
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: text },
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: stop, usage: noUsage },
  ])
}

function toolStream(toolName: string, args: unknown, callId: string): StreamResult {
  return streamOf([
    { type: 'tool-call', toolCallId: callId, toolName, input: JSON.stringify(args) },
    { type: 'finish', finishReason: toolCalls, usage: noUsage },
  ])
}

// Several complete tool-call parts in ONE assistant turn — the shape a model
// uses for parallel tool execution (the SDK runs the calls concurrently).
function multiToolStream(calls: { tool: string; args: unknown }[], stepIndex: number): StreamResult {
  return streamOf([
    ...calls.map(
      (c, i): LanguageModelV4StreamPart => ({
        type: 'tool-call',
        toolCallId: `call-${stepIndex}-${i}`,
        toolName: c.tool,
        input: JSON.stringify(c.args),
      }),
    ),
    { type: 'finish', finishReason: toolCalls, usage: noUsage },
  ])
}

// tool-input-end carries no payload (confirmed against the AI SDK's
// TextStreamPart type) — a real streaming provider still sends the complete
// `tool-call` part afterward; the SDK does not auto-synthesize one from the
// accumulated tool-input-delta text alone.
function streamingToolStream(toolName: string, argChunks: string[], callId: string): StreamResult {
  return streamOf([
    { type: 'tool-input-start', id: callId, toolName },
    ...argChunks.map((delta): LanguageModelV4StreamPart => ({ type: 'tool-input-delta', id: callId, delta })),
    { type: 'tool-input-end', id: callId },
    { type: 'tool-call', toolCallId: callId, toolName, input: argChunks.join('') },
    { type: 'finish', finishReason: toolCalls, usage: noUsage },
  ])
}

/**
 * Like `mockToolCallModel`, but the tool call's args arrive as streamed
 * `tool-input-start`/`tool-input-delta`×N/`tool-input-end` parts before the
 * complete `tool-call` part — exercises the `tool:input:*` crumb path.
 * `argChunks` must join to valid JSON matching the tool's schema.
 */
export function mockStreamingToolCallModel(opts: {
  toolName: string
  argChunks: string[]
  then: string
}): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: sequence(
      () => streamingToolStream(opts.toolName, opts.argChunks, 'call-0'),
      () => textStream(opts.then),
    ),
  })
}

/**
 * One model response in a scripted multi-step run: a tool call, several
 * parallel tool calls in one turn, or final text.
 */
export type ScriptStep = { tool: string; args: unknown } | { tools: { tool: string; args: unknown }[] } | { text: string }

/**
 * A model that replays one response per step, in order. Each tool step issues a
 * tool call (the SDK runs the tool and feeds the result back, advancing the
 * script); a `tools` step issues several calls in one turn (executed
 * concurrently by the SDK); the final step is usually `{ text }`. Generalizes
 * the single-tool, parallel-delegation, and loop (startLoop → finishLoop →
 * text) flows.
 */
export function mockScript(steps: ScriptStep[]): MockLanguageModelV4 {
  const factories = steps.map((step, i): StreamFactory => {
    if ('text' in step) return () => textStream(step.text)
    if ('tools' in step) return () => multiToolStream(step.tools, i)
    return () => toolStream(step.tool, step.args, `call-${i}`)
  })
  return new MockLanguageModelV4({ doStream: sequence(...factories) })
}

/**
 * A model that streams `text` as a single text block, then finishes. Drives the
 * `streamText` path in the runner (text:delta → agent:run:end). Reusable across
 * runs — each call regenerates the stream.
 */
export function mockTextModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: async () => textStream(text) })
}

/**
 * A model that streams `text` and records every `doStream` call's raw options
 * (temperature, providerOptions, etc.) — for asserting the runner actually
 * forwards `ModelRef.settings`/`providerOptions` through to the model.
 */
export function mockRecordingTextModel(text: string): {
  model: MockLanguageModelV4
  calls: LanguageModelV4CallOptions[]
} {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options)
      return textStream(text)
    },
  })
  return { model, calls }
}

/**
 * A model that streams `chunks` as separate text-delta parts, unlike
 * `mockTextModel`'s single combined delta — for tests that need to interrupt a
 * stream after some but not all deltas have arrived (e.g. asserting
 * `AbortSignal` cancellation mid-stream). `chunkDelayInMs` defaults to 0: when
 * a test drives the raw crumb generator directly via manual `.next()` calls,
 * consuming one crumb at a time already happens across separate stream ticks,
 * so no artificial delay is needed for a `controller.abort()` between reads to
 * land mid-stream deterministically. Pass a real delay when another layer sits
 * between the model and the test (e.g. an HTTP/SSE response body) and nothing
 * else paces the producer against the consumer's reads.
 */
export function mockChunkedTextModel(chunks: string[], chunkDelayInMs = 0): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () =>
      streamOf(
        [
          { type: 'text-start', id: '1' },
          ...chunks.map((delta): LanguageModelV4StreamPart => ({ type: 'text-delta', id: '1', delta })),
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: stop, usage: noUsage },
        ],
        chunkDelayInMs,
      ),
  })
}

/**
 * A model that emits a generated file part (mediaType + base64) before finishing —
 * drives the runner's `'file'` stream branch (file:generated crumb +
 * AgentRunEndCrumb.files). `text` streams after the file, mirroring how a real
 * multimodal model narrates alongside a generated image.
 */
export function mockFileGeneratingModel(text: string, file: { mediaType: string; base64: string }): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () =>
      streamOf([
        { type: 'file', mediaType: file.mediaType, data: { type: 'data', data: file.base64 } },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: text },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: stop, usage: noUsage },
      ]),
  })
}

/**
 * A model that streams `reasoning` as a reasoning block before `text` — drives
 * the runner's reasoning-delta branch (reasoning:delta → text:delta →
 * agent:run:end). Reusable across runs — each call regenerates the stream.
 */
export function mockReasoningTextModel(reasoning: string, text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () =>
      streamOf([
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: reasoning },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: text },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: stop, usage: noUsage },
      ]),
  })
}

/**
 * A model that calls `toolName` with `args`, then — once the tool result is fed
 * back — streams `then` as the final answer. Exercises the tool-call branch end
 * to end (tool:call → tool execution → tool:result → text).
 */
export function mockToolCallModel(opts: {
  toolName: string
  args: unknown
  then: string
}): MockLanguageModelV4 {
  return mockScript([{ tool: opts.toolName, args: opts.args }, { text: opts.then }])
}

/**
 * A model for the structured-output path (`output.format: 'json'`), which the
 * runner drives via `generateObject` (non-streaming). Returns `obj` as the
 * generated JSON content.
 */
export function mockObjectModel(obj: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify(obj) }],
      finishReason: stop,
      usage: noUsage,
      warnings: [],
    },
  })
}

/**
 * A structured-output model (like `mockObjectModel`) that records every
 * `doGenerate` call's raw options — for asserting `task.ts`'s `generateObject`
 * call forwards `ModelRef.settings`/`providerOptions` through to the model.
 */
export function mockRecordingObjectModel(obj: unknown): {
  model: MockLanguageModelV4
  calls: LanguageModelV4CallOptions[]
} {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options)
      return {
        content: [{ type: 'text', text: JSON.stringify(obj) }],
        finishReason: stop,
        usage: noUsage,
        warnings: [],
      }
    },
  })
  return { model, calls }
}

/** A model whose stream throws — used to assert the runner's error path. */
export function mockErrorModel(message = 'mock model failure'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new Error(message)
    },
  })
}

/**
 * A model whose stream emits an in-band `error` part after some text — a
 * provider failure surfaced as a stream part rather than a thrown error.
 * Exercises the runner's `error`-part branch (crumbs before the part still
 * stream; the run must then fail rather than "succeed" with truncated text).
 */
export function mockStreamErrorPartModel(message = 'in-band stream failure'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () =>
      streamOf([
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'partial ' },
        { type: 'error', error: new Error(message) },
        { type: 'finish', finishReason: stop, usage: noUsage },
      ]),
  })
}

/**
 * A structured-output model (like `mockObjectModel`) that throws on its first
 * `failTimes` calls, then succeeds with `obj` — for asserting onError's `retry`
 * action actually re-invokes the model rather than just resolving/propagating.
 */
export function mockFlakyObjectModel(failTimes: number, obj: unknown): MockLanguageModelV4 {
  let calls = 0
  return new MockLanguageModelV4({
    doGenerate: async () => {
      calls++
      if (calls <= failTimes) throw new Error(`flaky failure ${calls}`)
      return {
        content: [{ type: 'text', text: JSON.stringify(obj) }],
        finishReason: stop,
        usage: noUsage,
        warnings: [],
      }
    },
  })
}
