import { continuePipelineParent } from './pipeline.js'
import { crumbBase, nowMs } from './runner-helpers.js'
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
  BreadCrumb,
  CheckpointParent,
  HumanResumedCrumb,
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
  ctx: RunnerContext,
): AsyncGenerator<BreadCrumb> {
  const cp = await ctx.store.getCheckpoint(checkpointId)
  if (!cp) {
    throw new BreadError(
      `Checkpoint not found or already resumed: ${checkpointId}`,
      'CHECKPOINT_NOT_FOUND',
      { checkpointId },
    )
  }
  // A supervisor checkpoint chain-suspended by delegations is not directly
  // resumable — its dangling core_delegate call(s) resolve from the child
  // runs' outputs, never from a human response. Resume the children instead.
  if (cp.pending?.length) {
    throw new BreadError(
      `Checkpoint ${checkpointId} belongs to supervisor "${cp.agentId}" awaiting ` +
        `${cp.pending.length} suspended delegation(s) — resume the delegated run(s) instead ` +
        `(child checkpoint(s) at suspension time: ${cp.pending.map((p) => p.childCheckpointId).join(', ')}).`,
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
  let output: unknown
  if (kind === 'input') {
    output = response
  }

  // Atomically claim the checkpoint before doing anything else observable —
  // a concurrent second resume() of the same checkpoint loses this race and
  // hits CHECKPOINT_NOT_FOUND instead of also executing/appending. Once
  // claimed it's gone regardless of what happens below, so a failed tool
  // execution can no longer strand an orphaned-but-still-claimable checkpoint.
  const claimed = await ctx.store.deleteCheckpoint(checkpointId)
  if (!claimed) {
    throw new BreadError(
      `Checkpoint not found or already resumed: ${checkpointId}`,
      'CHECKPOINT_NOT_FOUND',
      { checkpointId },
    )
  }

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
    yield* continueParent(cp.parent, resumedOutput, ctx)
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
): AsyncGenerator<BreadCrumb> {
  if (parent.kind === 'pipeline') {
    yield* continuePipelineParent(parent, output, ctx)
    return
  }
  yield* continueSupervisorParent(parent, output, ctx)
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
    // ponytail: concurrent resumes of sibling delegations can race this
    // read-modify-write (same ceiling as parallel pipeline branches);
    // sequential resumes are correct.
    await ctx.store.saveCheckpoint({ ...scp, pending: remaining })
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
    yield* continueParent(scp.parent, output, ctx)
  }
}
