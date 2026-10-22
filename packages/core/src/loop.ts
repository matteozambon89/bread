import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { runWithOnErrorRetry } from './hooks.js'
import { runPipeline } from './pipeline.js'
import type { RunnerContext } from './runner.js'
import type {
  BreadCrumb,
  LoopConfig,
  LoopHostLink,
  LoopIterationEndCrumb,
  LoopStatus,
  PipelineStep,
  Principal,
  ToolDefinition,
} from './types.js'
import { BreadError } from './types.js'

function toLoopError(err: unknown, loopId: string): BreadError {
  if (err instanceof BreadError) return err
  return new BreadError(err instanceof Error ? err.message : String(err), 'LOOP_ERROR', { loopId }, err)
}

// Agent-driven loops. A host agent configured with `loop: { pool, maxIterations }`
// gets the core_start_loop / core_iterate_loop / core_finish_loop tools. The host
// composes a sequential pipeline from the pool, runs it, judges the output, and
// re-runs the SAME pipeline until satisfied or the (consumer-owned) cap is reached.

export interface BuildLoopToolsArgs {
  loopCfg: LoopConfig
  agentId: string
  runId: string
  sessionId: string
  ctx: RunnerContext
  // Sink that surfaces a crumb in the host run's stream (the runner's crumbBuffer).
  onCrumb: (crumb: BreadCrumb) => void
  // Host run principal. Passed into each iteration's pipeline.
  principal?: Principal
  // Set when continueRun rebuilds this runtime immediately after a suspended
  // iteration completed. Wins over the persisted loop lastOutput.
  restoredLastOutput?: { value: unknown }
}

export interface LoopRuntime {
  // Plain ToolDefinitions (not pre-wrapped AI-SDK tools) so the runner can fold
  // them into its uniform executables map and apply permissions/naming like any
  // other tool source, instead of merging a separate ToolSet.
  tools: ToolDefinition[]
  // Close a loop the agent left running when its run ends (or errors).
  finalize(failed: boolean): Promise<void>
  // Held, not forwarded live, so the runner can persist the host checkpoint
  // and the worker hostLoop link before a client can resume.
  takeHeldCrumbs(): BreadCrumb[]
}

export interface CompletedLoopIteration {
  crumb: LoopIterationEndCrumb
  toolResult: {
    loopId: string
    iteration: number
    maxIterations: number
    canIterate: boolean
    output: unknown
  }
  lastOutput: unknown
}

// Writes the open iteration once its pipeline frame has finished unsuspended.
// The hook runs before the row so a throw leaves nothing committed.
// The crumb shows the raw pipeline output; lastOutput / toolResult carry the
// onIterationEnd replacement, same as an iteration that never suspended.
// `beforeCommit` runs after the hook and before the row (the host claim).
export async function completeLoopIteration(
  ctx: RunnerContext,
  link: LoopHostLink,
  output: unknown,
  beforeCommit?: () => Promise<void>,
): Promise<CompletedLoopIteration> {
  const detail = await ctx.store.getLoop(link.loopId)
  if (!detail) {
    throw new BreadError(`Loop not found: "${link.loopId}".`, 'LOOP_NOT_FOUND', { loopId: link.loopId })
  }
  const { loop } = detail
  const hooks = ctx.agents.get(loop.agentId)?.config.loop?.hooks ?? {}
  const index = link.iteration
  const after = await hooks.onIterationEnd?.({ loopId: loop.id, iteration: index, output })
  const finalOutput = after ? after.output : output
  if (beforeCommit) await beforeCommit()
  await ctx.store.addLoopIteration({
    id: uuidv7(),
    loopId: loop.id,
    index,
    input: link.input,
    output,
    startedAt: link.startedAt,
    completedAt: Date.now(),
  })
  await ctx.store.updateLoop(loop.id, {
    iterations: index,
    lastOutput: finalOutput,
  })
  return {
    crumb: {
      type: 'loop:iteration:end',
      agentId: loop.agentId,
      runId: loop.runId,
      sessionId: loop.sessionId,
      timestamp: Date.now(),
      loopId: loop.id,
      iteration: index,
      output,
    },
    lastOutput: finalOutput,
    toolResult: {
      loopId: loop.id,
      iteration: index,
      maxIterations: loop.maxIterations,
      canIterate: index < loop.maxIterations,
      output: finalOutput,
    },
  }
}

interface ActiveLoop {
  loopId: string
  pipeline: string[]
  iteration: number // completed iterations
  lastOutput: unknown
  status: LoopStatus
}

const startLoopSchema = z.object({
  pipeline: z
    .array(z.string())
    .min(1)
    .describe('Ordered agent ids (each must be in the pool) to run sequentially each iteration'),
  input: z.unknown().describe('Initial input for the first iteration').optional(),
})
const iterateLoopSchema = z.object({
  feedback: z.unknown().describe('Your judgement/feedback to steer the next iteration').optional(),
})
const finishLoopSchema = z.object({
  result: z.unknown().describe('The final result you are satisfied with').optional(),
})

type StartLoopArgs = z.infer<typeof startLoopSchema>
type IterateLoopArgs = z.infer<typeof iterateLoopSchema>
type FinishLoopArgs = z.infer<typeof finishLoopSchema>

// One-line system-prompt hint, injected when the agent has a loop configured.
export function loopSummary(loopCfg: LoopConfig): string {
  return [
    '## Agent Loop',
    `You can run an iterative loop over a pipeline you compose from this pool of agents: ${loopCfg.pool.join(
      ', ',
    )}.`,
    'Call `core_start_loop` with `pipeline` (an ordered list of agent ids drawn from the pool) to run the ' +
      'pipeline once and receive its output.',
    'Judge that output. Call `core_iterate_loop` (optionally with `feedback`) to re-run the SAME pipeline ' +
      'and improve the result.',
    `When you are satisfied call \`core_finish_loop\` with your final result. The loop is capped at ${loopCfg.maxIterations} iterations.`,
  ].join('\n')
}

export async function buildLoopTools(args: BuildLoopToolsArgs): Promise<LoopRuntime> {
  const { loopCfg, agentId, runId, sessionId, ctx, onCrumb, principal, restoredLastOutput } = args

  let active: ActiveLoop | null = null
  // The host process that started the loop is gone after a chain-suspension.
  // Rebuild the in-memory cursor from the store so iterate/finish still see it.
  const running = await ctx.store.listLoops({ sessionId, agentId, status: 'running' })
  const mine = running.find((loop) => loop.runId === runId)
  if (mine) {
    const detail = await ctx.store.getLoop(mine.id)
    const last = detail?.iterations.at(-1)
    const loopRecord = detail?.loop
    // The iteration row stays raw. The post-hook value lives on the loop so a
    // later resume (or a new process) matches the tool result the model saw.
    // A present undefined is a hook replacement; only a missing field falls
    // back to the raw row. An older lastOutput must not outrank this iteration.
    const hasStoredLast =
      loopRecord !== undefined && Object.prototype.hasOwnProperty.call(loopRecord, 'lastOutput')
    active = {
      loopId: mine.id,
      pipeline: mine.pipeline,
      iteration: mine.iterations,
      lastOutput: restoredLastOutput
        ? restoredLastOutput.value
        : hasStoredLast
          ? loopRecord.lastOutput
          : last?.output,
      status: 'running',
    }
  }

  const base = () => ({ agentId, runId, sessionId, timestamp: Date.now() })
  // Loop crumbs surface through the host run's stream (the runner's
  // crumbBuffer); the instance-level choke point handles listeners/bus.
  const emit = onCrumb
  const hooks = loopCfg.hooks ?? {}
  // One batch per pipeline call. A shared array reset on the next call drops
  // the other suspension's human:required.
  const heldBatches: BreadCrumb[][] = []
  // streamText runs a step's tool calls concurrently, and stopWhen only fires
  // after the step. A second loop call must not start another pipeline.
  let loopBusy = false
  // core_start_loop / core_iterate_loop threw LOOP_SUSPENDED and no iteration
  // row exists yet. The in-flight guard stays held for the rest of this step;
  // iterate and finish must not run against that open iteration either.
  let suspendedWithoutRow = false
  function claimLoopCall(): void {
    if (loopBusy || suspendedWithoutRow) {
      throw new BreadError(
        'A loop tool call is already running in this turn.',
        'LOOP_TOOL_IN_FLIGHT',
        { agentId },
      )
    }
    loopBusy = true
  }
  function guard<A, R>(fn: (args: A) => Promise<R>): (args: A) => Promise<R> {
    return async (args) => {
      claimLoopCall()
      try {
        const result = await fn(args)
        loopBusy = false
        return result
      } catch (err) {
        // Keep the guard until this runtime is discarded. Releasing it in
        // finally lets a later tool in the same step iterate or finish the
        // open iteration before the host suspends.
        if (!(err instanceof BreadError && err.code === 'LOOP_SUSPENDED')) loopBusy = false
        throw err
      }
    }
  }

  // No bookkeeping here — a retry re-invokes just this, not finalizeIteration.
  // for-await drops runPipeline's return, so a suspension looked finished.
  // Read it and leave the iteration open instead.
  async function runPipelineOnce(input: unknown, startedAt: number): Promise<unknown> {
    const a = active!
    const steps: PipelineStep[] = a.pipeline.map((id) => ({ type: 'agent', agentId: id }))
    const gen = runPipeline({
      pipelineId: a.loopId,
      steps,
      input,
      ctx,
      ...(principal ? { principal } : {}),
    })
    const held: BreadCrumb[] = []
    heldBatches.push(held)
    const suspendedCheckpointIds: string[] = []
    for (;;) {
      const next = await gen.next()
      if (next.done) {
        if (next.value.suspended) {
          suspendedWithoutRow = true
          const checkpointId = suspendedCheckpointIds.at(-1)
          throw new BreadError(
            `Loop "${a.loopId}" iteration ${a.iteration + 1} suspended for human input` +
              (checkpointId ? ` (checkpoint ${checkpointId})` : '') +
              '; the host run suspends with it.',
            'LOOP_SUSPENDED',
            {
              loopId: a.loopId,
              iteration: a.iteration + 1,
              input,
              startedAt,
              ...(checkpointId ? { checkpointId } : {}),
              ...(suspendedCheckpointIds.length ? { checkpointIds: suspendedCheckpointIds } : {}),
            },
          )
        }
        return next.value.output
      }
      const crumb = next.value
      if (crumb.type === 'human:required') {
        suspendedCheckpointIds.push(crumb.checkpointId)
        held.push(crumb)
        continue
      }
      onCrumb(crumb)
    }
  }

  // Persists, advances, and closes out one iteration given its (possibly
  // onError-recovered) output. Also runs onIterationEnd, which may replace
  // the output — that replacement becomes the new lastOutput and what's
  // returned to the tool caller, though the persisted record/crumb still
  // show the raw pipeline output (same convention as Agent/Task/Tool afterRun).
  async function finalizeIteration(input: unknown, output: unknown, startedAt: number): Promise<unknown> {
    const a = active!
    const index = a.iteration + 1
    const after = await hooks.onIterationEnd?.({ loopId: a.loopId, iteration: index, output })
    const finalOutput = after ? after.output : output
    await ctx.store.addLoopIteration({
      id: uuidv7(),
      loopId: a.loopId,
      index,
      input,
      output,
      startedAt,
      completedAt: Date.now(),
    })
    await ctx.store.updateLoop(a.loopId, {
      iterations: index,
      lastOutput: finalOutput,
    })
    a.iteration = index
    a.lastOutput = finalOutput
    emit({ type: 'loop:iteration:end', ...base(), loopId: a.loopId, iteration: index, output })
    return finalOutput
  }

  // Runs one iteration end to end: onIterationStart, the pipeline wrapped in
  // onError's recover/retry/fail resolution, then finalizeIteration.
  async function runIteration(input: unknown): Promise<unknown> {
    const a = active!
    const nextIndex = a.iteration + 1
    const startedAt = Date.now()
    emit({ type: 'loop:iteration:start', ...base(), loopId: a.loopId, iteration: nextIndex })
    await hooks.onIterationStart?.({ loopId: a.loopId, iteration: nextIndex, input })

    const output = await runWithOnErrorRetry<unknown>(
      () => runPipelineOnce(input, startedAt),
      (error) => Promise.resolve(hooks.onError?.({ loopId: a.loopId, iteration: nextIndex, error })),
      (err) => toLoopError(err, a.loopId),
      loopCfg.errorHandling?.retry,
    )

    return finalizeIteration(input, output, startedAt)
  }

  const startLoop: ToolDefinition<StartLoopArgs, unknown> = {
    name: 'core_start_loop',
    description:
      'Start an iterative loop. Compose `pipeline` as an ordered list of agent ids drawn from the ' +
      'pool; the pipeline runs once and its output is returned for you to judge.',
    schema: startLoopSchema,
    execute: guard(async ({ pipeline, input }): Promise<unknown> => {
      if (active && active.status === 'running') {
        throw new BreadError(
          'A loop is already running; call core_finish_loop before starting another.',
          'LOOP_ALREADY_ACTIVE',
          { agentId, loopId: active.loopId },
        )
      }
      const notInPool = pipeline.filter((id) => !loopCfg.pool.includes(id))
      if (notInPool.length) {
        throw new BreadError(
          `Pipeline agents not in the configured pool: ${notInPool.join(', ')}. ` +
            `Allowed pool: ${loopCfg.pool.join(', ')}.`,
          'LOOP_AGENT_NOT_IN_POOL',
          { agentId, notInPool, pool: loopCfg.pool },
        )
      }
      const missing = pipeline.filter((id) => !ctx.agents.has(id))
      if (missing.length) {
        throw new BreadError(
          `Pipeline agents are not registered: ${missing.join(', ')}.`,
          'AGENT_NOT_FOUND',
          { agentId, missing },
        )
      }

      const loopId = uuidv7()
      active = { loopId, pipeline, iteration: 0, lastOutput: undefined, status: 'running' }
      await ctx.store.createLoop({
        id: loopId,
        agentId,
        sessionId,
        runId,
        pool: loopCfg.pool,
        pipeline,
        maxIterations: loopCfg.maxIterations,
        status: 'running',
        iterations: 0,
        startedAt: Date.now(),
      })
      emit({
        type: 'loop:start',
        ...base(),
        loopId,
        pipeline,
        maxIterations: loopCfg.maxIterations,
      })
      await hooks.onInit?.({ loopId, pipeline, maxIterations: loopCfg.maxIterations })

      const output = await runIteration(input)
      return {
        loopId,
        iteration: active.iteration,
        maxIterations: loopCfg.maxIterations,
        canIterate: active.iteration < loopCfg.maxIterations,
        output,
      }
    }),
  }

  const iterateLoop: ToolDefinition<IterateLoopArgs, unknown> = {
    name: 'core_iterate_loop',
    description:
      'Re-run the SAME pipeline for another iteration, optionally steering it with `feedback`. ' +
      'Use after judging the previous output. Returns the new output.',
    schema: iterateLoopSchema,
    execute: guard(async ({ feedback }): Promise<unknown> => {
      if (!active || active.status !== 'running') {
        throw new BreadError('No active loop. Call core_start_loop first.', 'NO_ACTIVE_LOOP', {
          agentId,
        })
      }
      if (active.iteration >= loopCfg.maxIterations) {
        active.status = 'exhausted'
        await ctx.store.updateLoop(active.loopId, {
          status: 'exhausted',
          result: active.lastOutput,
          completedAt: Date.now(),
        })
        emit({
          type: 'loop:end',
          ...base(),
          loopId: active.loopId,
          status: 'exhausted',
          iterations: active.iteration,
          result: active.lastOutput,
        })
        await hooks.onFinish?.({ loopId: active.loopId, status: 'exhausted', iterations: active.iteration })
        const result = {
          exhausted: true,
          iteration: active.iteration,
          maxIterations: loopCfg.maxIterations,
          lastOutput: active.lastOutput,
          message: 'maxIterations reached — the loop is closed. Use the last output as your result.',
        }
        active = null
        return result
      }

      const nextInput =
        feedback === undefined ? active.lastOutput : { previousOutput: active.lastOutput, feedback }
      const output = await runIteration(nextInput)
      return {
        loopId: active.loopId,
        iteration: active.iteration,
        maxIterations: loopCfg.maxIterations,
        canIterate: active.iteration < loopCfg.maxIterations,
        output,
      }
    }),
  }

  const finishLoop: ToolDefinition<FinishLoopArgs, unknown> = {
    name: 'core_finish_loop',
    description: 'Finish the active loop, recording your final judged result.',
    schema: finishLoopSchema,
    execute: guard(async ({ result }): Promise<unknown> => {
      if (!active || active.status !== 'running') {
        throw new BreadError('No active loop to finish. Call core_start_loop first.', 'NO_ACTIVE_LOOP', {
          agentId,
        })
      }
      const finalResult = result === undefined ? active.lastOutput : result
      active.status = 'completed'
      await ctx.store.updateLoop(active.loopId, {
        status: 'completed',
        result: finalResult,
        completedAt: Date.now(),
      })
      emit({
        type: 'loop:end',
        ...base(),
        loopId: active.loopId,
        status: 'completed',
        iterations: active.iteration,
        result: finalResult,
      })
      await hooks.onFinish?.({ loopId: active.loopId, status: 'completed', iterations: active.iteration })
      const out = { loopId: active.loopId, iterations: active.iteration, result: finalResult }
      active = null
      return out
    }),
  }

  async function finalize(failed: boolean): Promise<void> {
    if (!active || active.status !== 'running') return
    const status: LoopStatus = failed ? 'failed' : 'completed'
    active.status = status
    await ctx.store.updateLoop(active.loopId, {
      status,
      completedAt: Date.now(),
      ...(failed ? {} : { result: active.lastOutput }),
    })
    emit({
      type: 'loop:end',
      ...base(),
      loopId: active.loopId,
      status,
      iterations: active.iteration,
      ...(failed ? {} : { result: active.lastOutput }),
    })
    await hooks.onFinish?.({ loopId: active.loopId, status, iterations: active.iteration })
    active = null
  }

  return {
    tools: [startLoop, iterateLoop, finishLoop],
    finalize,
    takeHeldCrumbs() {
      const held = heldBatches.flat()
      heldBatches.length = 0
      return held
    },
  }
}
