import { type Tool, type ToolSet, tool } from 'ai'
import { envProvider, scopedProvider } from './credentials.js'
import { crumbBase, nowMs } from './runner-helpers.js'
import type { ExecutableEntry } from './runner-types.js'
import {
  runAfterRunChain,
  runBeforeRunChain,
  runOnErrorChainOnce,
  runWithOnErrorRetry,
} from './hooks.js'
import type { BlobStore } from './storage/blob-store.js'
import type {
  BreadCrumb,
  BreadHooks,
  CredentialProvider,
  GlobalHookContext,
  HumanToolDefinition,
  ToolContext,
  ToolDefinition,
  ToolErrorCrumb,
  ToolResultCrumb,
  ToolResultPartialCrumb,
  ToolRunContext,
} from './types.js'
import { BreadError } from './types.js'

// Single construction point for a tool's credential provider. Priority:
// 1. the tool's own `def.credentialProvider`, if it set one;
// 2. the run-wide `BreadConfig.credentials` default, if configured;
// 3. `envProvider()` — unscoped `process.env` access, matching pre-wiring
//    behavior exactly when nothing is configured (non-breaking default).
// The result is then scoped to `def.credentials` — secure by default, so a tool that
// declares no names gets none, rather than inheriting unscoped access to the base provider.
export function buildToolCredentials(
  def: ToolDefinition,
  defaultProvider: CredentialProvider | undefined,
): CredentialProvider {
  return scopedProvider(def.credentialProvider ?? defaultProvider ?? envProvider(), def.credentials)
}

function toToolError(err: unknown, toolName: string): BreadError {
  if (err instanceof BreadError) return err
  return new BreadError(err instanceof Error ? err.message : String(err), 'TOOL_ERROR', { toolName }, err)
}

// Builds the ordered [scoped, ...plugins, global] hook array for one
// beforeRun/afterRun/onError key, same pattern as agentHookChain/taskHookChain
// (Tools have no onSuspend — they never suspend for HITL).
function toolHookChain<K extends 'beforeRun' | 'afterRun' | 'onError'>(
  def: ToolDefinition,
  pluginHooks: Partial<BreadHooks>[] | undefined,
  globalHooks: Partial<BreadHooks> | undefined,
  key: K,
): Array<BreadHooks[K] | undefined> {
  return [
    def.hooks?.[key] as unknown as BreadHooks[K] | undefined,
    ...(pluginHooks ?? []).map((h) => h[key]),
    globalHooks?.[key],
  ]
}

// Static, call-free check: an `async function*`'s constructor is
// 'AsyncGeneratorFunction' — the only shape whose call-time return value (an
// AsyncGenerator) satisfies the AI SDK's isAsyncIterable() detection. A plain
// `async function` always returns a Promise instead, regardless of whether
// its body happens to loop/await internally — so this dispatch must happen
// on the function itself, before ever calling it.
export function isGeneratorExecute(execute: unknown): boolean {
  return typeof execute === 'function' && execute.constructor.name === 'AsyncGeneratorFunction'
}

// Runs one tool call end to end: beforeRun (override args / short-circuit),
// emit tool:call, the real def.execute wrapped in onError's recover/retry/fail
// resolution, emit tool:result (or tool:error if unresolved), afterRun (may
// replace the result). Shared by both buildExecuteTool's AI-SDK adapter and
// resumeRun's approved-tool-call path, so both get identical hook/crumb/error
// behavior from one implementation.
export async function executeToolWithHooks(
  leaf: string,
  def: ToolDefinition,
  args: unknown,
  toolCallId: string,
  agentId: string,
  runId: string,
  sessionId: string,
  onCrumb: (crumb: BreadCrumb) => void,
  defaultCredentials: CredentialProvider | undefined,
  pluginHooks: Partial<BreadHooks>[] | undefined,
  globalHooks: Partial<BreadHooks> | undefined,
  signal: AbortSignal | undefined,
  blobStore: BlobStore | undefined,
): Promise<unknown> {
  const credentials = buildToolCredentials(def, defaultCredentials)
  const hookCtx: ToolRunContext = { agentId, sessionId, runId, toolName: leaf, credentials }
  const chain = <K extends 'beforeRun' | 'afterRun' | 'onError'>(key: K) =>
    toolHookChain(def, pluginHooks, globalHooks, key)

  const before = await runBeforeRunChain<unknown, unknown, GlobalHookContext>(chain('beforeRun'), {
    scope: 'tool',
    ...hookCtx,
    input: args,
  })
  const toolArgs = before.input

  const callCrumb: BreadCrumb = {
    type: 'tool:call',
    ...crumbBase(agentId, runId, sessionId),
    toolCallId,
    toolName: leaf,
    args: toolArgs,
  }
  onCrumb(callCrumb)

  if (before.shortCircuited) {
    const output = await runAfterRunChain<unknown, unknown, GlobalHookContext>(chain('afterRun'), {
      scope: 'tool',
      ...hookCtx,
      input: toolArgs,
      output: before.output,
      durationMs: 0,
    })
    const resultCrumb: ToolResultCrumb = {
      type: 'tool:result',
      ...crumbBase(agentId, runId, sessionId),
      toolCallId,
      toolName: leaf,
      result: output,
      durationMs: 0,
    }
    onCrumb(resultCrumb)
    return output
  }

  const start = nowMs()
  const toolCtx: ToolContext = {
    agentId,
    sessionId,
    runId,
    credentials,
    ...(signal ? { signal } : {}),
    ...(blobStore ? { blobStore } : {}),
  }

  try {
    const output = await runWithOnErrorRetry<unknown>(
      // Cast, not a behavior change: this function only ever runs when
      // isGeneratorExecute(def.execute) is false (see buildExecuteTool/
      // resumeRun's dispatch), so def.execute's return here is always
      // Promise<R>/R at runtime. The widened ToolDefinition.execute union
      // (AsyncIterable<R> | PromiseLike<R> | R) collapses to bare `unknown`
      // once R is erased to unknown in this untyped ToolDefinition, so TS can
      // no longer infer Promise<unknown> from the call itself without help.
      () => def.execute(toolArgs as never, toolCtx) as Promise<unknown>,
      (error) =>
        runOnErrorChainOnce<unknown, unknown, GlobalHookContext>(chain('onError'), {
          scope: 'tool',
          ...hookCtx,
          input: toolArgs,
          error,
        }),
      (err) => toToolError(err, leaf),
      def.errorHandling?.retry,
    )
    const dur = nowMs() - start

    const resultCrumb: ToolResultCrumb = {
      type: 'tool:result',
      ...crumbBase(agentId, runId, sessionId),
      toolCallId,
      toolName: leaf,
      result: output,
      durationMs: dur,
    }
    onCrumb(resultCrumb)

    return runAfterRunChain<unknown, unknown, GlobalHookContext>(chain('afterRun'), {
      scope: 'tool',
      ...hookCtx,
      input: toolArgs,
      output,
      durationMs: dur,
    })
  } catch (err) {
    // Unresolved by onError: emit tool:error (the AI SDK's own `tool-error`
    // stream part isn't otherwise surfaced — see ToolErrorCrumb) and rethrow.
    // A chain-suspension escaping through core_delegate is not an error — no
    // crumb; the rethrow carries it to the runner's suspend path.
    const finalErr = toToolError(err, leaf)
    if (finalErr.code !== 'DELEGATION_SUSPENDED') {
      const errorCrumb: ToolErrorCrumb = {
        type: 'tool:error',
        ...crumbBase(agentId, runId, sessionId),
        toolCallId,
        toolName: leaf,
        error: finalErr,
        durationMs: nowMs() - start,
      }
      onCrumb(errorCrumb)
    }
    throw finalErr
  }
}

// Streaming sibling of executeToolWithHooks — used only when def.execute is
// statically an async generator function (isGeneratorExecute). Same
// beforeRun/tool:call/short-circuit prelude, then drains def.execute's
// AsyncIterable instead of a single await, emitting one tool:result:partial
// crumb per yielded value, the final tool:result crumb once the iterable is
// exhausted, and tool:error on an unresolved throw. Declared `async
// function*` (not a plain async function) deliberately: only a function
// whose call-time return is itself an AsyncIterable is detected as streaming
// by the AI SDK's own isAsyncIterable() check — see buildExecuteTool's
// dispatch. Unlike executeToolWithHooks, this does NOT wrap the drain in
// runWithOnErrorRetry — retrying a partially-streamed operation has no
// principled replay semantics (re-emit already-seen partials? restart from
// scratch?) — out of scope this round; a streaming tool's
// errorHandling.retry has no effect.
export async function* executeStreamingToolWithHooks(
  leaf: string,
  def: ToolDefinition,
  args: unknown,
  toolCallId: string,
  agentId: string,
  runId: string,
  sessionId: string,
  onCrumb: (crumb: BreadCrumb) => void,
  defaultCredentials: CredentialProvider | undefined,
  pluginHooks: Partial<BreadHooks>[] | undefined,
  globalHooks: Partial<BreadHooks> | undefined,
  signal: AbortSignal | undefined,
  blobStore: BlobStore | undefined,
): AsyncGenerator<unknown, unknown, undefined> {
  const credentials = buildToolCredentials(def, defaultCredentials)
  const hookCtx: ToolRunContext = { agentId, sessionId, runId, toolName: leaf, credentials }
  const chain = <K extends 'beforeRun' | 'afterRun' | 'onError'>(key: K) =>
    toolHookChain(def, pluginHooks, globalHooks, key)

  const before = await runBeforeRunChain<unknown, unknown, GlobalHookContext>(chain('beforeRun'), {
    scope: 'tool',
    ...hookCtx,
    input: args,
  })
  const toolArgs = before.input

  const callCrumb: BreadCrumb = {
    type: 'tool:call',
    ...crumbBase(agentId, runId, sessionId),
    toolCallId,
    toolName: leaf,
    args: toolArgs,
  }
  onCrumb(callCrumb)

  if (before.shortCircuited) {
    const output = await runAfterRunChain<unknown, unknown, GlobalHookContext>(chain('afterRun'), {
      scope: 'tool',
      ...hookCtx,
      input: toolArgs,
      output: before.output,
      durationMs: 0,
    })
    const resultCrumb: ToolResultCrumb = {
      type: 'tool:result',
      ...crumbBase(agentId, runId, sessionId),
      toolCallId,
      toolName: leaf,
      result: output,
      durationMs: 0,
    }
    onCrumb(resultCrumb)
    yield output
    return output
  }

  const start = nowMs()
  const toolCtx: ToolContext = {
    agentId,
    sessionId,
    runId,
    credentials,
    ...(signal ? { signal } : {}),
    ...(blobStore ? { blobStore } : {}),
  }

  try {
    let lastValue: unknown
    const iterable = def.execute(toolArgs as never, toolCtx) as AsyncIterable<unknown>
    for await (const value of iterable) {
      lastValue = value
      const partialCrumb: ToolResultPartialCrumb = {
        type: 'tool:result:partial',
        ...crumbBase(agentId, runId, sessionId),
        toolCallId,
        toolName: leaf,
        result: value,
      }
      onCrumb(partialCrumb)
      yield value
    }
    const dur = nowMs() - start

    const resultCrumb: ToolResultCrumb = {
      type: 'tool:result',
      ...crumbBase(agentId, runId, sessionId),
      toolCallId,
      toolName: leaf,
      result: lastValue,
      durationMs: dur,
    }
    onCrumb(resultCrumb)

    const finalOutput = await runAfterRunChain<unknown, unknown, GlobalHookContext>(chain('afterRun'), {
      scope: 'tool',
      ...hookCtx,
      input: toolArgs,
      output: lastValue,
      durationMs: dur,
    })
    // Extra yield beyond the tool's own progress values: makes the AI SDK's
    // own lastOutput (what the model sees as the tool result, and what gets
    // persisted into session history) reflect afterRun's possibly-replaced
    // output, not just the raw last yielded value. Surfaces to the SDK as one
    // redundant preliminary-marked fullStream 'tool-result' part ahead of its
    // own synthesized final one — harmless, since continueRun's fullStream
    // loop has no branch for 'tool-result' at all (bread's tool:result crumb
    // above is already the single source of truth).
    yield finalOutput
    return finalOutput
  } catch (err) {
    const finalErr = toToolError(err, leaf)
    const errorCrumb: ToolErrorCrumb = {
      type: 'tool:error',
      ...crumbBase(agentId, runId, sessionId),
      toolCallId,
      toolName: leaf,
      error: finalErr,
      durationMs: nowMs() - start,
    }
    onCrumb(errorCrumb)
    throw finalErr
  }
}

// Builds the actual AI-SDK tool result for one executable, identical for every
// scope: delegate to executeToolWithHooks, or its streaming sibling when
// def.execute is statically an async generator function. The `execute:`
// field itself is deliberately not `async` so whichever branch's return value
// (a Promise or an AsyncGenerator) passes through to the SDK unwrapped —
// that's what makes the SDK's own isAsyncIterable() detection work per call.
function buildExecuteTool(
  leaf: string,
  def: ToolDefinition,
  agentId: string,
  runId: string,
  sessionId: string,
  onCrumb: (crumb: BreadCrumb) => void,
  defaultCredentials: CredentialProvider | undefined,
  pluginHooks: Partial<BreadHooks>[] | undefined,
  globalHooks: Partial<BreadHooks> | undefined,
  signal: AbortSignal | undefined,
  blobStore: BlobStore | undefined,
): Tool {
  return tool({
    description: def.description,
    inputSchema: def.schema,
    execute: (args, { toolCallId }) =>
      isGeneratorExecute(def.execute)
        ? executeStreamingToolWithHooks(
            leaf,
            def,
            args,
            toolCallId,
            agentId,
            runId,
            sessionId,
            onCrumb,
            defaultCredentials,
            pluginHooks,
            globalHooks,
            signal,
            blobStore,
          )
        : executeToolWithHooks(
            leaf,
            def,
            args,
            toolCallId,
            agentId,
            runId,
            sessionId,
            onCrumb,
            defaultCredentials,
            pluginHooks,
            globalHooks,
            signal,
            blobStore,
          ),
  }) as Tool
}

// Builds the model-facing AI-SDK toolset, keyed by leaf name. `gated` entries
// and human tools are registered without `execute`: the model's call halts the
// stream (via the `hasToolCall` stop condition in continueRun) instead of
// running, and the run suspends on a checkpoint for resume to settle later.
export function buildAiSdkTools(
  executables: Map<string, ExecutableEntry>,
  gated: Set<string>,
  humanLeaves: Map<string, HumanToolDefinition<any>>,
  agentId: string,
  runId: string,
  sessionId: string,
  onCrumb: (crumb: BreadCrumb) => void,
  defaultCredentials: CredentialProvider | undefined,
  pluginHooks: Partial<BreadHooks>[] | undefined,
  globalHooks: Partial<BreadHooks> | undefined,
  signal: AbortSignal | undefined,
  blobStore: BlobStore | undefined,
): ToolSet {
  const result: ToolSet = {}

  for (const [leaf, { def }] of executables) {
    result[leaf] = gated.has(leaf)
      ? (tool({ description: def.description, inputSchema: def.schema }) as Tool)
      : buildExecuteTool(
          leaf,
          def,
          agentId,
          runId,
          sessionId,
          onCrumb,
          defaultCredentials,
          pluginHooks,
          globalHooks,
          signal,
          blobStore,
        )
  }

  for (const [leaf, hDef] of humanLeaves) {
    result[leaf] = tool({
      description: `Ask a human: ${hDef.name}`,
      inputSchema: hDef.schema,
    }) as Tool
  }

  return result
}
