import { completeLoopIteration } from './loop.js'
import {
  dropPendingLoopHosts,
  loopHostLinkOf,
  markLoopFailed,
  missingHostCheckpoint,
  retargetLoopHostPending,
} from './loop-host.js'
import { continuePipelineParent } from './pipeline.js'
import type { FinishedLoopFrame } from './pipeline.js'
import { TOOL_SCOPES, leafName } from './permissions.js'
import { crumbBase, makeHumanRequiredCrumb, nowMs } from './runner-helpers.js'
import { continueRun } from './runner-continue.js'
import {
  executeStreamingToolWithHooks,
  executeToolWithHooks,
  isGeneratorExecute,
} from './runner-tool-execution.js'
import { assembleTools } from './runner-tool-assembly.js'
import type { RunnerContext } from './runner-types.js'
import type {
  AgentConfig,
  AgentDefinition,
  BreadCrumb,
  CheckpointParent,
  HumanResumedCrumb,
  LoopEndCrumb,
  LoopHostLink,
  Principal,
  RunOptions,
  SupervisorCheckpointParent,
} from './types.js'
import { BreadError } from './types.js'

// Resumes a suspended HITL run from the store. Reconstructs the run state from
// persisted session messages, appends the human's answer as the pending tool's
// result, and continues — independent of whether the original run generator is
// still in memory (it usually is not: a restart or a different container).
export async function* resumeRun(
  checkpointId: string,
  response: unknown,
  baseCtx: Omit<RunnerContext, 'executionId'>,
): AsyncGenerator<BreadCrumb> {
  const cp = await baseCtx.store.getCheckpoint(checkpointId)
  if (!cp) {
    throw new BreadError(
      `Checkpoint not found or already resumed: ${checkpointId}`,
      'CHECKPOINT_NOT_FOUND',
      { checkpointId },
    )
  }
  // The stored row, not the caller, decides which execution this resume continues.
  // A row without one (written before execution ids existed) is refused rather
  // than continued under the shared '' id every legacy row backfilled to.
  if (!cp.executionId) {
    throw new BreadError(
      `Checkpoint ${checkpointId} has no execution id and cannot be resumed; it predates execution ids`,
      'CHECKPOINT_NOT_RESUMABLE',
      { checkpointId },
    )
  }
  const ctx: RunnerContext = { ...baseCtx, executionId: cp.executionId }
  // A chain-suspended host checkpoint is not directly resumable — its dangling
  // tool call resolves from the child run, never from a human response.
  // Resume the child instead. Loop hosts dangle core_start_loop /
  // core_iterate_loop; supervisors dangle core_delegate.
  if (cp.pending?.length) {
    const childIds = cp.pending.map((p) => p.childCheckpointId).join(', ')
    const loopHost = cp.toolName === 'core_start_loop' || cp.toolName === 'core_iterate_loop'
    if (loopHost) {
      const live = []
      for (const entry of cp.pending) {
        if (await ctx.store.getCheckpoint(entry.childCheckpointId)) live.push(entry)
      }
      if (live.length === 0) {
        const running = await ctx.store.listLoops({
          sessionId: cp.sessionId,
          agentId: cp.agentId,
          status: 'running',
        })
        for (const loop of running) {
          if (loop.runId === cp.runId) await markLoopFailed(ctx, loop.id)
        }
        await ctx.store.deleteCheckpoint(cp.id)
        await dropPendingLoopHosts(ctx, cp.parent, cp.pending[0]?.childCheckpointId ?? cp.id)
        throw new BreadError(
          `Checkpoint ${checkpointId} belongs to loop host "${cp.agentId}" but its worker ` +
            `checkpoint is gone (${childIds}). The loop was marked failed.`,
          'LOOP_CHECKPOINT_NOT_RESUMABLE',
          { checkpointId, agentId: cp.agentId, pending: cp.pending },
        )
      }
      if (live.length !== cp.pending.length) {
        await ctx.store.saveCheckpoint({ ...cp, pending: live })
      }
      const liveIds = live.map((entry) => entry.childCheckpointId).join(', ')
      throw new BreadError(
        `Checkpoint ${checkpointId} belongs to loop host "${cp.agentId}" awaiting a suspended ` +
          `iteration — resume the worker checkpoint instead (checkpoint at suspension time: ${liveIds}).`,
        'LOOP_CHECKPOINT_NOT_RESUMABLE',
        { checkpointId, agentId: cp.agentId, pending: live },
      )
    }
    throw new BreadError(
      `Checkpoint ${checkpointId} belongs to supervisor "${cp.agentId}" awaiting ` +
        `${cp.pending.length} suspended delegation(s) — resume the delegated run(s) instead ` +
        `(child checkpoint(s) at suspension time: ${childIds}).`,
      'SUPERVISOR_CHECKPOINT_NOT_RESUMABLE',
      { checkpointId, agentId: cp.agentId, pending: cp.pending },
    )
  }
  const def = ctx.agents.get(cp.agentId)
  if (!def) {
    throw new BreadError(`Agent not found: "${cp.agentId}"`, 'AGENT_NOT_FOUND', {
      agentId: cp.agentId,
    })
  }
  const cfg = def.config as AgentConfig<unknown, unknown>
  // Carry the composition linkage forward: if the resumed run suspends again,
  // its new checkpoint keeps the same pipeline continuation.
  const runOpts: RunOptions = {
    ...(cp.skill ? { skill: cp.skill } : {}),
    ...(cp.principal ? { principal: cp.principal } : {}),
    ...(cp.parent ? { _parent: cp.parent } : {}),
  }

  // Rebuild the same leaf names continueRun would for this config, with no
  // stored flag on the checkpoint: cp.toolName is a human leaf (input) or it
  // isn't, in which case it's an ask-gated leaf awaiting approve/reject.
  const { executables, humanLeaves } = await assembleTools(
    cp.agentId,
    cfg,
    cp.runId,
    cp.sessionId,
    runOpts,
    ctx,
    () => {},
  )
  const kind: 'input' | 'approval' = humanLeaves.has(cp.toolName) ? 'input' : 'approval'

  // Note: HumanToolDefinition.schema validates the *model's* args when it
  // calls the human tool (the question posed) — it's wired as that AI-SDK
  // tool's inputSchema (see buildHumanTools), not a schema for the human's
  // answer. There is no declared shape for `response` to validate against;
  // taking it as-is is correct given the current defineHumanTool API, not a
  // gap — see kind === 'input' below.
  // A loop worker is claimed, not deleted. The row has to stay so the host
  // can still resolve it; the loser throws and does not fail the loop.
  // Other checkpoints are still deleted up front so a concurrent second
  // resume loses the race.
  const loopWorker = (await loopHostLinkOf(ctx, cp.parent)) !== undefined
  if (!loopWorker) {
    // unclaimedOnly: a loop worker whose supervisor row a first resume already
    // deleted looks like a plain checkpoint here. Its claim must still win.
    const claimed = await ctx.store.deleteCheckpoint(checkpointId, { unclaimedOnly: true })
    if (!claimed) {
      throw new BreadError(
        `Checkpoint not found or already resumed: ${checkpointId}`,
        'CHECKPOINT_NOT_FOUND',
        { checkpointId },
      )
    }
  } else {
    const claimed = await ctx.store.claimCheckpoint(checkpointId)
    if (!claimed) {
      throw new BreadError(
        `Checkpoint not found or already resumed: ${checkpointId}`,
        'CHECKPOINT_NOT_FOUND',
        { checkpointId },
      )
    }
    ctx.releasingLoopWorkerId = checkpointId
  }

  let settled = false
  try {
    for await (const crumb of resumeClaimed(checkpointId, response, cp, kind, executables, def, runOpts, ctx)) {
      if (
        ctx.releasingLoopWorkerId === checkpointId &&
        (crumb.type === 'loop:iteration:end' ||
          (crumb.type === 'human:required' && crumb.checkpointId !== checkpointId))
      ) {
        // An inner iteration end still has the worker on an outer host.
        // A replacement human:required already retargets hosts onto the new id.
        if (!(await checkpointStillPending(ctx, checkpointId))) {
          ctx.releasingLoopWorkerId = undefined
          await ctx.store.deleteCheckpoint(checkpointId)
        }
      }
      yield crumb
    }
    settled = true
  } catch (err) {
    settled = true
    await abandonLoopWorker(ctx, cp.parent, checkpointId)
    throw err
  } finally {
    // A consumer that stops reading (break, return(), a dropped stream) never
    // reaches the iteration end that releases the worker. Never unclaim it:
    // the same answer could then be resumed again and its tools run twice.
    if (!settled && ctx.releasingLoopWorkerId === checkpointId) {
      await abandonLoopWorker(ctx, cp.parent, checkpointId)
    }
  }
}

// The worker row is still here. A host is dropped (and its loop failed) only
// when this id was its last live child — a sibling that is still stored keeps
// the loop running.
async function abandonLoopWorker(
  ctx: RunnerContext,
  parent: CheckpointParent | undefined,
  checkpointId: string,
): Promise<void> {
  await dropPendingLoopHosts(ctx, parent, checkpointId)
  if (ctx.releasingLoopWorkerId === checkpointId) {
    ctx.releasingLoopWorkerId = undefined
    await ctx.store.deleteCheckpoint(checkpointId)
  }
}

async function checkpointStillPending(ctx: RunnerContext, checkpointId: string): Promise<boolean> {
  const all = await ctx.store.listCheckpoints({ executionId: ctx.executionId })
  return all.some(
    (cp) =>
      (cp.toolName === 'core_start_loop' || cp.toolName === 'core_iterate_loop') &&
      cp.pending?.some((entry) => entry.childCheckpointId === checkpointId),
  )
}

async function* resumeClaimed(
  checkpointId: string,
  response: unknown,
  cp: NonNullable<Awaited<ReturnType<RunnerContext['store']['getCheckpoint']>>>,
  kind: 'input' | 'approval',
  executables: Awaited<ReturnType<typeof assembleTools>>['executables'],
  def: AgentDefinition<unknown, unknown>,
  runOpts: RunOptions,
  ctx: RunnerContext,
): AsyncGenerator<BreadCrumb> {
  let output: unknown
  if (kind === 'input') output = response

  if (kind === 'approval') {
    const approved = (response as { approved?: boolean } | undefined)?.approved === true
    if (approved) {
      const executable = executables.get(cp.toolName)
      if (!executable) {
        throw new BreadError(
          `Approved tool "${cp.toolName}" is no longer available on this agent.`,
          'TOOL_NOT_FOUND',
          { toolName: cp.toolName },
        )
      }
      // Same beforeRun/afterRun/onError chain and crumb behavior as a live
      // tool call — see executeToolWithHooks. Same isGeneratorExecute
      // dispatch as buildExecuteTool: an approved, ask-gated streaming tool
      // must be drained here too — without this, executeToolWithHooks would
      // `await` the raw AsyncGenerator object (not a Promise) and silently
      // persist that object as the tool result.
      const toolCrumbs: BreadCrumb[] = []
      try {
        if (isGeneratorExecute(executable.def.execute)) {
          const gen = executeStreamingToolWithHooks(
            cp.toolName,
            executable.def,
            cp.schema,
            cp.toolCallId,
            cp.agentId,
            cp.runId,
            cp.sessionId,
            (c) => toolCrumbs.push(c),
            ctx.credentials,
            ctx.pluginHooks,
            ctx.hooks,
            ctx.signal,
            ctx.blobStore,
            cp.principal,
          )
          let final: unknown
          for await (const value of gen) final = value
          output = final
        } else {
          output = await executeToolWithHooks(
            cp.toolName,
            executable.def,
            cp.schema,
            cp.toolCallId,
            cp.agentId,
            cp.runId,
            cp.sessionId,
            (c) => toolCrumbs.push(c),
            ctx.credentials,
            ctx.pluginHooks,
            ctx.hooks,
            ctx.signal,
            ctx.blobStore,
            cp.principal,
          )
        }
      } finally {
        for (const c of toolCrumbs) yield c
      }
    } else {
      output = { denied: true, reason: 'rejected by human' }
    }
  }

  // Append the tool result. Session history now holds the complete run state.
  await ctx.store.addMessage(cp.sessionId, {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: cp.toolCallId,
        toolName: cp.toolName,
        output: { type: 'json', value: output },
      },
    ],
    timestamp: nowMs(),
  })

  const resumedCrumb: HumanResumedCrumb = {
    type: 'human:resumed',
    ...crumbBase(cp.agentId, cp.runId, cp.sessionId),
    checkpointId,
    response,
    kind,
  }
  yield resumedCrumb

  // Watch the continuation for the run's end: if the checkpoint carries a
  // pipeline parent, the rest of the composition runs after the sub-run
  // completes. A re-suspension (another human:required) ends the stream with
  // no agent:run:end — the new checkpoint carries the same parent, so the
  // eventual final resume picks the pipeline back up.
  let resumedOutput: unknown
  let ended = false
  for await (const crumb of continueRun(cp.agentId, def, cp.runId, cp.sessionId, response, runOpts, ctx)) {
    yield crumb
    if (crumb.type === 'agent:run:end') {
      resumedOutput = crumb.output
      ended = true
    }
  }

  if (ended && cp.parent) {
    yield* continueParent(cp.parent, resumedOutput, ctx, cp.principal)
  }
}

// Dispatches a completed sub-run's output to whatever composition suspended on
// it. Recursive through continueSupervisorParent: a supervisor that continues
// to completion hands its own output up to ITS parent (supervisor inside a
// pipeline, delegation chains, …).
async function* continueParent(
  parent: CheckpointParent,
  output: unknown,
  ctx: RunnerContext,
  principal?: Principal,
): AsyncGenerator<BreadCrumb> {
  if (parent.kind === 'pipeline') {
    const finished = yield* continuePipelineParent(parent, output, ctx, undefined, principal)
    if (!finished) return
    if ('hostLoop' in finished && finished.hostLoop) {
      yield* continueLoopHost(finished, ctx)
      return
    }
    if (finished.supervisor) yield* continueSupervisorParent(finished.supervisor, finished.output, ctx)
    return
  }
  yield* continueSupervisorParent(parent, output, ctx)
}

// The loop frame finished unsuspended and has no outer frame. Write the open
// iteration, hand that result to the host as the dangling tool result, and
// continue the host. A fresh LoopRuntime is seeded inside continueRun.
async function* continueLoopHost(
  finished: FinishedLoopFrame,
  ctx: RunnerContext,
): AsyncGenerator<BreadCrumb> {
  const link: LoopHostLink = finished.hostLoop
  const hostCp = await ctx.store.getCheckpoint(link.checkpointId)
  if (!hostCp) {
    await markLoopFailed(ctx, link.loopId)
    throw missingHostCheckpoint(link.checkpointId, link.loopId)
  }

  let claimedHost = false
  let completed: Awaited<ReturnType<typeof completeLoopIteration>>
  try {
    completed = await completeLoopIteration(ctx, link, finished.output, async () => {
      const claimed = await ctx.store.deleteCheckpoint(hostCp.id)
      if (!claimed) throw missingHostCheckpoint(hostCp.id, link.loopId)
      claimedHost = true
    })
  } catch (err) {
    if (claimedHost) yield* closeLoopIfRunning(ctx, link.loopId, 'failed')
    throw err
  }
  yield completed.crumb

  try {
    await ctx.store.addMessage(hostCp.sessionId, {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: link.toolCallId,
          toolName: link.toolName,
          output: { type: 'json', value: completed.toolResult },
        },
      ],
      timestamp: nowMs(),
    })
  } catch (err) {
    yield* closeLoopIfRunning(ctx, link.loopId, 'failed')
    throw err
  }

  const def = ctx.agents.get(hostCp.agentId)
  if (!def) {
    yield* closeLoopIfRunning(ctx, link.loopId, 'failed')
    throw new BreadError(`Agent not found: "${hostCp.agentId}"`, 'AGENT_NOT_FOUND', {
      agentId: hostCp.agentId,
    })
  }
  const runOpts: RunOptions = {
    ...(hostCp.skill ? { skill: hostCp.skill } : {}),
    ...(hostCp.principal ? { principal: hostCp.principal } : {}),
    ...(hostCp.parent ? { _parent: hostCp.parent } : {}),
    _loopLastOutput: { value: completed.lastOutput },
  }
  const failingChildId = hostCp.pending?.[0]?.childCheckpointId ?? hostCp.id

  try {
    let output: unknown
    let ended = false
    for await (const crumb of continueRun(
      hostCp.agentId,
      def,
      hostCp.runId,
      hostCp.sessionId,
      completed.toolResult,
      runOpts,
      ctx,
    )) {
      yield crumb
      if (crumb.type === 'agent:run:end') {
        output = crumb.output
        ended = true
      }
    }

    // The host was claimed before this run. A throw before the loop runtime
    // exists, or an onError recover that skips finalize, would leave the loop
    // running with both checkpoints gone. A runtime that already finalized
    // (status no longer running) is left as-is.
    if (ended) yield* closeLoopIfRunning(ctx, link.loopId, 'completed', completed.lastOutput)
    if (ended && hostCp.parent) {
      yield* continueParent(hostCp.parent, output, ctx, hostCp.principal)
    } else if (ended && finished.supervisor) {
      yield* continueSupervisorParent(finished.supervisor, output, ctx)
    }
  } catch (err) {
    // This host checkpoint is already claimed, so its parent is the only
    // place an outer loop's link still lives.
    await dropPendingLoopHosts(ctx, hostCp.parent, failingChildId)
    yield* closeLoopIfRunning(ctx, link.loopId, 'failed')
    throw err
  }
}

// Same store row and loop:end crumb as LoopRuntime.finalize. No-op when the
// runtime already closed the loop. Does not delete another checkpoint.
async function* closeLoopIfRunning(
  ctx: RunnerContext,
  loopId: string,
  status: 'completed' | 'failed',
  result?: unknown,
): AsyncGenerator<BreadCrumb> {
  const detail = await ctx.store.getLoop(loopId)
  if (!detail || detail.loop.status !== 'running') return
  const completedAt = nowMs()
  await ctx.store.updateLoop(loopId, {
    status,
    completedAt,
    ...(status === 'completed' ? { result } : {}),
  })
  const crumb: LoopEndCrumb = {
    type: 'loop:end',
    agentId: detail.loop.agentId,
    runId: detail.loop.runId,
    sessionId: detail.loop.sessionId,
    timestamp: completedAt,
    loopId,
    status,
    iterations: detail.loop.iterations,
    ...(status === 'completed' ? { result } : {}),
  }
  yield crumb
  await ctx.agents.get(detail.loop.agentId)?.config.loop?.hooks?.onFinish?.({
    loopId,
    status,
    iterations: detail.loop.iterations,
  })
}

// A delegated child run completed: feed its output back as the supervisor's
// pending core_delegate tool result. Only the last outstanding delegation's
// resume continues the supervisor run; earlier ones persist their result and
// stop (the supervisor stays suspended on the rest).
async function* continueSupervisorParent(
  parent: SupervisorCheckpointParent,
  childOutput: unknown,
  ctx: RunnerContext,
): AsyncGenerator<BreadCrumb> {
  const scp = await ctx.store.getCheckpoint(parent.checkpointId)
  if (!scp) {
    // The supervisor checkpoint is gone — session deleted or a concurrent
    // resume raced us to completion. The child's own resume already streamed;
    // nothing left to continue.
    return
  }

  // The tool result persists immediately, whether or not the supervisor
  // continues now — the session must hold it before the final delegation's
  // resume replays the run.
  await ctx.store.addMessage(scp.sessionId, {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: parent.toolCallId,
        toolName: scp.toolName,
        output: { type: 'json', value: childOutput },
      },
    ],
    timestamp: nowMs(),
  })

  const remaining = (scp.pending ?? []).filter((p) => p.toolCallId !== parent.toolCallId)
  if (remaining.length > 0) {
    // Concurrent resumes of sibling delegations can race this
    // read-modify-write (same ceiling as parallel pipeline branches);
    // sequential resumes are correct.
    await ctx.store.saveCheckpoint({ ...scp, pending: remaining })
    const sibling = await firstLivePending(ctx, remaining)
    if (sibling && (await retargetLoopHostPending(ctx, sibling.id))) {
      yield makeHumanRequiredCrumb(
        sibling.agentId,
        sibling.runId,
        sibling.sessionId,
        sibling.id,
        sibling.toolName,
        sibling.schema,
        suspensionKind(ctx, sibling.agentId, sibling.toolName),
      )
    }
    return
  }

  // Last outstanding delegation: claim the supervisor checkpoint atomically —
  // a concurrent sibling resume loses this race and stops at the getCheckpoint
  // miss above or here.
  const claimed = await ctx.store.deleteCheckpoint(scp.id)
  if (!claimed) return

  const def = ctx.agents.get(scp.agentId)
  if (!def) {
    throw new BreadError(`Agent not found: "${scp.agentId}"`, 'AGENT_NOT_FOUND', {
      agentId: scp.agentId,
    })
  }
  const runOpts: RunOptions = {
    ...(scp.skill ? { skill: scp.skill } : {}),
    ...(scp.principal ? { principal: scp.principal } : {}),
    ...(scp.parent ? { _parent: scp.parent } : {}),
  }

  let output: unknown
  let ended = false
  for await (const crumb of continueRun(scp.agentId, def, scp.runId, scp.sessionId, childOutput, runOpts, ctx)) {
    yield crumb
    if (crumb.type === 'agent:run:end') {
      output = crumb.output
      ended = true
    }
  }

  if (ended && scp.parent) {
    yield* continueParent(scp.parent, output, ctx, scp.principal)
  }
}

async function firstLivePending(
  ctx: RunnerContext,
  pending: NonNullable<NonNullable<Awaited<ReturnType<RunnerContext['store']['getCheckpoint']>>>['pending']>,
): Promise<NonNullable<Awaited<ReturnType<RunnerContext['store']['getCheckpoint']>>> | undefined> {
  for (const entry of pending) {
    const child = await ctx.store.getCheckpoint(entry.childCheckpointId)
    if (child) return child
  }
  return undefined
}

function suspensionKind(ctx: RunnerContext, agentId: string, toolName: string): 'input' | 'approval' {
  const humans = (ctx.agents.get(agentId)?.config as { _humanTools?: { name: string }[] } | undefined)?._humanTools
  if (humans?.some((tool) => leafName({ scope: TOOL_SCOPES.HUMAN, name: tool.name }) === toolName)) return 'input'
  return 'approval'
}
