import { v7 as uuidv7 } from 'uuid'
import {
  type LanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
  generateObject,
  hasToolCall,
  stepCountIs,
  streamText,
} from 'ai'
import { modelCallOptions, resolveModel } from './model-provider.js'
import {
  decideRetry,
  runAfterRunChain,
  runObserverChain,
  runOnErrorChainOnce,
} from './hooks.js'
import { nextBackoffDelay, sleep } from './retry.js'
import {
  agentHookChain,
  cancelledOutcome,
  crumbBase,
  makeErrorCrumb,
  makeHumanRequiredCrumb,
  nowMs,
  toBreadError,
} from './runner-helpers.js'
import { assembleTools } from './runner-tool-assembly.js'
import { buildAiSdkTools } from './runner-tool-execution.js'
import type { RunnerContext } from './runner-types.js'
import type { FileOutput } from './storage/blob-store.js'
import type { CheckpointRecord } from './storage/store.js'
import type {
  AgentConfig,
  AgentDefinition,
  AgentRunEndCrumb,
  BreadCrumb,
  GlobalHookContext,
  HumanRequiredEvent,
  RunContext,
  RunOptions,
} from './types.js'
import { BreadError } from './types.js'

// Persisted rows are AI SDK ModelMessages: `content` is a plain string (user
// rows and legacy assistant rows) or an array of structured parts (assistant
// tool-calls, tool results). Both are valid ModelMessage content, so pass them
// through unchanged — this preserves tool-call/result context across turns and
// lets a suspended run be replayed from history.
function toModelMessages(prior: Array<{ role: string; content: unknown }>): ModelMessage[] {
  return prior.map((m) => ({ role: m.role, content: m.content }) as ModelMessage)
}

// Drives the model call for one run segment: an initial run or a post-resume
// continuation. Reads the session history as the prompt, streams crumbs, and
// either ends the run (`agent:run:end`) or, when the model calls a human tool,
// suspends it (`human:required`) after persisting a checkpoint.
export async function* continueRun(
  agentId: string,
  def: AgentDefinition<unknown, unknown>,
  runId: string,
  sessionId: string,
  input: unknown,
  opts: RunOptions,
  ctx: RunnerContext,
): AsyncGenerator<BreadCrumb> {
  const cfg = def.config as AgentConfig<unknown, unknown>
  const start = nowMs()
  const retryConfig = cfg.errorHandling?.retry
  const runCtx: RunContext = {
    agentId,
    runId,
    sessionId,
    ...(opts.skill ? { skill: opts.skill } : {}),
  }

  // Crumb buffer — tool.execute runs inside AI SDK's promise chain, not in
  // the async generator tick, so we buffer crumbs emitted from there and
  // flush them in the stream loop.
  const crumbBuffer: BreadCrumb[] = []

  let model: LanguageModel
  {
    const retryState = { attempt: 1, usedUnconfiguredRetry: false }
    let delay = retryConfig?.backoffMs ?? 500
    for (;;) {
      try {
        model = await resolveModel(cfg.model, [cfg.providers, ctx.providers])
        break
      } catch (err) {
        if (ctx.signal?.aborted) {
          const { crumb, error } = cancelledOutcome(agentId, runId, sessionId)
          yield crumb
          throw error
        }

        const breadErr = toBreadError(err, agentId)
        const resolution = await runOnErrorChainOnce<unknown, unknown, GlobalHookContext>(
          agentHookChain(cfg, ctx, 'onError'),
          { scope: 'agent', ...runCtx, input, error: breadErr },
        )
        const decision = decideRetry(resolution, breadErr, retryConfig, retryState)

        if (decision.action === 'recover') {
          const output = await runAfterRunChain<unknown, unknown, GlobalHookContext>(
            agentHookChain(cfg, ctx, 'afterRun'),
            { scope: 'agent', ...runCtx, input, output: decision.output, durationMs: nowMs() - start },
          )
          const endCrumb: AgentRunEndCrumb = {
            type: 'agent:run:end',
            ...crumbBase(agentId, runId, sessionId),
            output,
            durationMs: nowMs() - start,
          }
          yield endCrumb
          return
        }

        if (decision.action !== 'retry') {
          const finalErr = decision.action === 'fail' ? (decision.error ?? breadErr) : breadErr
          const errCrumb = makeErrorCrumb(agentId, runId, sessionId, finalErr)
          yield errCrumb
          throw finalErr
        }

        if (retryConfig) {
          await sleep(delay, ctx.signal)
          if (ctx.signal?.aborted) {
            const { crumb, error } = cancelledOutcome(agentId, runId, sessionId)
            yield crumb
            throw error
          }
          delay = nextBackoffDelay(delay, retryConfig)
        }
        retryState.attempt++
      }
    }
  }

  // Load session history (already includes the user message / resumed tool
  // result persisted by the caller) and reconstruct the model prompt.
  const priorMessages = await ctx.store.getMessages(sessionId)
  const messages = toModelMessages(
    priorMessages.map((m) => ({ role: m.role, content: m.content })),
  )

  const { system, executables, humanLeaves, gated, loopRuntime, supervisorRuntime } = await assembleTools(
    agentId,
    cfg,
    runId,
    sessionId,
    opts,
    ctx,
    (c) => crumbBuffer.push(c),
  )

  const aiTools = buildAiSdkTools(
    executables,
    gated,
    humanLeaves,
    agentId,
    runId,
    sessionId,
    (c) => crumbBuffer.push(c),
    ctx.credentials,
    ctx.pluginHooks,
    ctx.hooks,
    ctx.signal,
    ctx.blobStore,
  )

  const hasTools = Object.keys(aiTools).length > 0

  // Delegate tool calls whose sub-run suspended for HITL this attempt — each
  // chain-suspends this run instead of erroring. Filled from the stream's
  // tool-error parts (the DELEGATION_SUSPENDED throw), reset per attempt.
  const suspendedDelegations: Array<{
    toolCallId: string
    toolName: string
    args: unknown
    childCheckpointId: string
    subAgentId: string
  }> = []

  // Stop the tool loop on step budget, and also the moment a human or
  // ask-gated tool is called so the run can suspend for input/approval
  // instead of looping forever — or a delegation suspends, so the model never
  // sees (and reacts to) the synthetic tool error backing the suspension.
  const maxSteps = cfg.steps?.max ?? 20
  const stopWhen = [
    stepCountIs(maxSteps),
    ...[...humanLeaves.keys()].map((leaf) => hasToolCall(leaf)),
    ...[...gated].map((leaf) => hasToolCall(leaf)),
    () => suspendedDelegations.length > 0,
  ]

  const mainRetryState = { attempt: 1, usedUnconfiguredRetry: false }
  let mainDelay = retryConfig?.backoffMs ?? 500

  for (;;) {
    try {
      if (cfg.output.format === 'json' && cfg.outputSchema) {
        // Structured output — generateObject, no streaming (and no HITL).
        const result = await generateObject({
          model,
          schema: cfg.outputSchema,
          messages,
          maxRetries: cfg.errorHandling?.retry?.attempts ?? 2,
          ...(system ? { system } : {}),
          ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
          ...modelCallOptions(cfg.model),
        })

        while (crumbBuffer.length) yield crumbBuffer.shift()!

        // afterRun runs before persisting/emitting so its (possibly replaced)
        // output is what's actually recorded in history and the crumb.
        const output = await runAfterRunChain<unknown, unknown, GlobalHookContext>(
          agentHookChain(cfg, ctx, 'afterRun'),
          { scope: 'agent', ...runCtx, input, output: result.object, durationMs: nowMs() - start },
        )

        // generateObject exposes no response.messages; persist the structured
        // object as the assistant reply so it survives in multi-turn history.
        await ctx.store.addMessage(sessionId, {
          role: 'assistant',
          content: JSON.stringify(output),
          timestamp: nowMs(),
        })

        const endCrumb: AgentRunEndCrumb = {
          type: 'agent:run:end',
          ...crumbBase(agentId, runId, sessionId),
          output,
          durationMs: nowMs() - start,
        }
        yield endCrumb
        return
      }

      // Text / streaming. Drop any stale suspension state from a failed
      // previous attempt before the model runs again.
      suspendedDelegations.length = 0
      supervisorRuntime?.takeHeldCrumbs()
      const streamResult = streamText({
        model,
        messages,
        maxRetries: cfg.errorHandling?.retry?.attempts ?? 2,
        stopWhen,
        ...(hasTools ? { tools: aiTools } : {}),
        ...(system ? { system } : {}),
        ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
        ...modelCallOptions(cfg.model),
      })

      let fullText = ''
      const files: FileOutput[] = []
      // Set when the model calls a human or ask-gated tool: the run suspends
      // after this stream instead of executing it.
      let pending: { kind: 'input' | 'approval'; toolCallId: string; toolName: string; args: unknown } | null =
        null

      for await (const part of streamResult.fullStream as AsyncIterable<TextStreamPart<ToolSet>>) {
        while (crumbBuffer.length) yield crumbBuffer.shift()!

        if (part.type === 'text-delta') {
          fullText += part.text
          const delta: BreadCrumb = {
            type: 'text:delta',
            ...crumbBase(agentId, runId, sessionId),
            delta: part.text,
          }
          yield delta
        } else if (part.type === 'reasoning-delta') {
          const delta: BreadCrumb = {
            type: 'reasoning:delta',
            ...crumbBase(agentId, runId, sessionId),
            delta: part.text,
          }
          yield delta
        } else if (part.type === 'file') {
          // A model that generates a file directly (e.g. an image-generation-capable
          // model) — no tool call involved. See docs/store.md#blob-storage.
          if (!ctx.blobStore) {
            throw new BreadError(
              `Agent "${agentId}" model generated a file but no blobStore is configured — see docs/store.md#blob-storage`,
              'BLOB_STORE_NOT_CONFIGURED',
              { agentId, runId, mimeType: part.file.mediaType },
            )
          }
          const { url } = await ctx.blobStore.put(part.file.uint8Array, { mimeType: part.file.mediaType })
          files.push({ kind: 'file', uri: url, mimeType: part.file.mediaType })
          const fileCrumb: BreadCrumb = {
            type: 'file:generated',
            ...crumbBase(agentId, runId, sessionId),
            uri: url,
            mimeType: part.file.mediaType,
          }
          yield fileCrumb
        } else if (part.type === 'tool-input-start') {
          const startCrumb: BreadCrumb = {
            type: 'tool:input:start',
            ...crumbBase(agentId, runId, sessionId),
            toolCallId: part.id,
            toolName: part.toolName,
          }
          yield startCrumb
        } else if (part.type === 'tool-input-delta') {
          const inputDelta: BreadCrumb = {
            type: 'tool:input:delta',
            ...crumbBase(agentId, runId, sessionId),
            toolCallId: part.id,
            delta: part.delta,
          }
          yield inputDelta
        } else if (part.type === 'tool-input-end') {
          const endCrumb: BreadCrumb = {
            type: 'tool:input:end',
            ...crumbBase(agentId, runId, sessionId),
            toolCallId: part.id,
          }
          yield endCrumb
        } else if (part.type === 'tool-call') {
          if (humanLeaves.has(part.toolName)) {
            // Human tool: capture it and emit human:required after the stream
            // closes — no tool:call crumb (it never executes locally).
            pending = { kind: 'input', toolCallId: part.toolCallId, toolName: part.toolName, args: part.input }
            continue
          }
          if (gated.has(part.toolName)) {
            // Ask-gated tool: same suspend path as a human tool, but the real
            // tool runs on approval instead of being answered by a human.
            pending = { kind: 'approval', toolCallId: part.toolCallId, toolName: part.toolName, args: part.input }
            continue
          }
          // Normal tool: the AI SDK auto-invokes buildExecuteTool's `execute`
          // (executeToolWithHooks) for this same call, which already emits
          // tool:call/tool:result itself — hook-transformed args/output, real
          // duration, via the buffered onCrumb path. Nothing to do here; a
          // second, worse-quality crumb from this raw part was the bug.
        } else if (part.type === 'tool-error') {
          // A delegated sub-run suspended for HITL: core_delegate's
          // DELEGATION_SUSPENDED throw surfaces here as the SDK's tool-error
          // part. Record it — the stop condition halts the loop after this
          // step and the suspend path below chain-suspends this run. Genuine
          // tool errors already emitted their tool:error crumb in the wrapper
          // and flow back to the model as error results; nothing to do here.
          const toolErr = (part as { error?: unknown }).error
          if (toolErr instanceof BreadError && toolErr.code === 'DELEGATION_SUSPENDED') {
            const errCtx = (toolErr.context ?? {}) as { checkpointId?: string; subAgentId?: string }
            if (errCtx.checkpointId) {
              suspendedDelegations.push({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                args: part.input,
                childCheckpointId: errCtx.checkpointId,
                subAgentId: errCtx.subAgentId ?? 'unknown',
              })
            }
          }
        } else if (part.type === 'error') {
          // A provider/transport failure surfaced in-band as a stream part
          // rather than a thrown error. Rethrow into the main catch so the
          // onError chain, retry policy, and agent:error crumb all apply —
          // without this branch the part is dropped and the run "succeeds".
          throw part.error
        }
      }

      while (crumbBuffer.length) yield crumbBuffer.shift()!

      // Persist the model's response messages (assistant text/tool-calls and tool
      // results) as structured rows so tool context survives across turns and a
      // suspended run can be replayed. `response` resolves once the stream above
      // is fully consumed; per-turn rows share a timestamp and rely on the store's
      // monotonic message id for intra-turn ordering.
      const { messages: responseMessages } = await streamResult.response
      const responseRows = responseMessages.map((rm) => ({
        role: rm.role,
        content: rm.content,
        timestamp: nowMs(),
      }))

      // Chain-suspension: one or more delegations suspended for HITL. Persist
      // this run's state with the delegate tool-call(s) left dangling (their
      // synthetic error results stripped), link each child checkpoint back,
      // and only then surface the children's held human:required crumbs — a
      // client resuming the instant it sees one finds complete linkage.
      if (suspendedDelegations.length > 0) {
        if (pending) {
          // ponytail: a turn mixing a suspended delegation with a human/ask-
          // gated tool call would need two interleaved suspension records —
          // fail loud instead of picking one silently. Split the calls across
          // turns (or support it here) if a real model ever does this.
          throw new BreadError(
            `Agent "${agentId}" called a ${pending.kind === 'input' ? 'human' : 'ask-gated'} tool and ` +
              'had a delegation suspend in the same turn — this combination is unsupported. ',
            'MIXED_SUSPENSION_UNSUPPORTED',
            { agentId, runId, toolName: pending.toolName, delegations: suspendedDelegations.length },
          )
        }
        const suspendedIds = new Set(suspendedDelegations.map((d) => d.toolCallId))
        const strippedRows = responseRows
          .map((row) => {
            if (row.role !== 'tool' || !Array.isArray(row.content)) return row
            const content = (row.content as Array<{ type?: string; toolCallId?: string }>).filter(
              (p) => !(p.toolCallId !== undefined && suspendedIds.has(p.toolCallId)),
            )
            return { ...row, content }
          })
          .filter((row) => !(row.role === 'tool' && Array.isArray(row.content) && row.content.length === 0))

        const supervisorCpId = uuidv7()
        const first = suspendedDelegations[0]!
        const record: CheckpointRecord = {
          id: supervisorCpId,
          agentId,
          runId,
          sessionId,
          toolName: first.toolName,
          toolCallId: first.toolCallId,
          schema: first.args,
          ...(opts.skill ? { skill: opts.skill } : {}),
          ...(opts._parent ? { parent: opts._parent } : {}),
          pending: suspendedDelegations.map((d) => ({
            toolCallId: d.toolCallId,
            childCheckpointId: d.childCheckpointId,
            subAgentId: d.subAgentId,
          })),
          createdAt: nowMs(),
        }
        await ctx.store.suspendRun(sessionId, strippedRows, record)

        for (const d of suspendedDelegations) {
          const childCp = await ctx.store.getCheckpoint(d.childCheckpointId)
          if (childCp) {
            await ctx.store.saveCheckpoint({
              ...childCp,
              parent: { kind: 'supervisor', checkpointId: supervisorCpId, toolCallId: d.toolCallId },
            })
          }
        }

        for (const crumb of supervisorRuntime?.takeHeldCrumbs() ?? []) yield crumb

        await runObserverChain(agentHookChain(cfg, ctx, 'onSuspend'), {
          scope: 'agent',
          ...runCtx,
          toolName: first.toolName,
          checkpointId: supervisorCpId,
        })
        return
      }

      // Suspend on a human or ask-gated tool: persist the response messages and
      // the checkpoint as one atomic unit (suspendRun), then emit human:required.
      // The assistant message carrying the pending tool-call is already
      // persisted, so resume can reconstruct and continue the run from the
      // store — and a crash between the two can never leave a dangling
      // tool-call with no checkpoint to resume it.
      if (pending) {
        const checkpointId = uuidv7()
        const record: CheckpointRecord = {
          id: checkpointId,
          agentId,
          runId,
          sessionId,
          toolName: pending.toolName,
          toolCallId: pending.toolCallId,
          schema: pending.args,
          ...(opts.skill ? { skill: opts.skill } : {}),
          // Composition linkage (runPipeline sets _parent): persisted atomically
          // with the checkpoint so resume continues the surrounding pipeline.
          ...(opts._parent ? { parent: opts._parent } : {}),
          createdAt: nowMs(),
        }
        await ctx.store.suspendRun(sessionId, responseRows, record)

        const event: HumanRequiredEvent = {
          agentId,
          runId,
          sessionId,
          checkpointId,
          toolName: pending.toolName,
          schema: pending.args,
          kind: pending.kind,
        }
        ctx.onHumanRequired?.(event)

        const crumb = makeHumanRequiredCrumb(
          agentId,
          runId,
          sessionId,
          checkpointId,
          pending.toolName,
          pending.args,
          pending.kind,
        )
        yield crumb

        await runObserverChain(agentHookChain(cfg, ctx, 'onSuspend'), {
          scope: 'agent',
          ...runCtx,
          toolName: pending.toolName,
          checkpointId,
        })
        return
      }

      for (const row of responseRows) {
        await ctx.store.addMessage(sessionId, row)
      }

      // Close a loop the agent left running, then flush any loop:end crumb.
      if (loopRuntime) await loopRuntime.finalize(false)
      while (crumbBuffer.length) yield crumbBuffer.shift()!

      // Parse output — 'json' is handled earlier via generateObject; a CustomFormat parses the
      // streamed text into O directly; plain 'text'/'markdown' need no parsing at all, since
      // OutputFormat<O> only allows those literals when O extends string.
      const output: unknown = typeof cfg.output.format === 'string' ? fullText : cfg.output.format.parse(fullText)

      const afterOutput = await runAfterRunChain<unknown, unknown, GlobalHookContext>(
        agentHookChain(cfg, ctx, 'afterRun'),
        { scope: 'agent', ...runCtx, input, output, durationMs: nowMs() - start },
      )
      const endCrumb: AgentRunEndCrumb = {
        type: 'agent:run:end',
        ...crumbBase(agentId, runId, sessionId),
        output: afterOutput,
        durationMs: nowMs() - start,
        ...(files.length ? { files } : {}),
      }
      yield endCrumb
      return
    } catch (err) {
      if (ctx.signal?.aborted) {
        if (loopRuntime) await loopRuntime.finalize(true)
        while (crumbBuffer.length) yield crumbBuffer.shift()!
        const { crumb, error } = cancelledOutcome(agentId, runId, sessionId)
        yield crumb
        throw error
      }

      const breadErr = toBreadError(err, agentId)
      const resolution = await runOnErrorChainOnce<unknown, unknown, GlobalHookContext>(
        agentHookChain(cfg, ctx, 'onError'),
        { scope: 'agent', ...runCtx, input, error: breadErr },
      )
      const decision = decideRetry(resolution, breadErr, retryConfig, mainRetryState)

      if (decision.action === 'recover') {
        const output = await runAfterRunChain<unknown, unknown, GlobalHookContext>(
          agentHookChain(cfg, ctx, 'afterRun'),
          { scope: 'agent', ...runCtx, input, output: decision.output, durationMs: nowMs() - start },
        )
        const endCrumb: AgentRunEndCrumb = {
          type: 'agent:run:end',
          ...crumbBase(agentId, runId, sessionId),
          output,
          durationMs: nowMs() - start,
        }
        yield endCrumb
        return
      }

      if (decision.action === 'retry') {
        // Discard crumbs buffered by the failed attempt's tool calls — that
        // attempt is being thrown away, not partially replayed.
        crumbBuffer.length = 0
        if (retryConfig) {
          await sleep(mainDelay, ctx.signal)
          if (ctx.signal?.aborted) {
            if (loopRuntime) await loopRuntime.finalize(true)
            const { crumb, error } = cancelledOutcome(agentId, runId, sessionId)
            yield crumb
            throw error
          }
          mainDelay = nextBackoffDelay(mainDelay, retryConfig)
        }
        mainRetryState.attempt++
        continue
      }

      // 'fail', or 'stop' (every hook was void and no retry applies): give up.
      const finalErr = decision.action === 'fail' ? (decision.error ?? breadErr) : breadErr
      if (loopRuntime) await loopRuntime.finalize(true)
      while (crumbBuffer.length) yield crumbBuffer.shift()!
      const errCrumb = makeErrorCrumb(agentId, runId, sessionId, finalErr)
      yield errCrumb
      throw finalErr
    }
  }
}
