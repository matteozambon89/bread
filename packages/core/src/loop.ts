import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { runWithOnErrorRetry } from './hooks.js'
import { runPipeline } from './pipeline.js'
import type { RunnerContext } from './runner.js'
import type { BreadCrumb, LoopConfig, LoopStatus, PipelineStep, ToolDefinition } from './types.js'
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
}

export interface LoopRuntime {
  // Plain ToolDefinitions (not pre-wrapped AI-SDK tools) so the runner can fold
  // them into its uniform executables map and apply permissions/naming like any
  // other tool source, instead of merging a separate ToolSet.
  tools: ToolDefinition[]
  // Close a loop the agent left running when its run ends (or errors).
  finalize(failed: boolean): Promise<void>
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

export function buildLoopTools(args: BuildLoopToolsArgs): LoopRuntime {
  const { loopCfg, agentId, runId, sessionId, ctx, onCrumb } = args

  let active: ActiveLoop | null = null

  const base = () => ({ agentId, runId, sessionId, timestamp: Date.now() })
  // Loop crumbs surface through the host run's stream (the runner's
  // crumbBuffer); the instance-level choke point handles listeners/bus.
  const emit = onCrumb
  const hooks = loopCfg.hooks ?? {}

  // Run the composed pipeline once, forwarding inner crumbs to the host stream.
  // No bookkeeping here — a retry re-invokes just this, not the persist/emit
  // steps in finalizeIteration below.
  async function runPipelineOnce(input: unknown): Promise<unknown> {
    const a = active!
    const steps: PipelineStep[] = a.pipeline.map((id) => ({ type: 'agent', agentId: id }))
    let output: unknown
    for await (const crumb of runPipeline({
      pipelineId: a.loopId,
      steps,
      input,
      ctx,
    })) {
      // Surface inner pipeline/agent crumbs in the host run's stream.
      onCrumb(crumb)
      if (crumb.type === 'pipeline:step:end') output = crumb.output
    }
    return output
  }

  // Persists, advances, and closes out one iteration given its (possibly
  // onError-recovered) output. Also runs onIterationEnd, which may replace
  // the output — that replacement becomes the new lastOutput and what's
  // returned to the tool caller, though the persisted record/crumb still
  // show the raw pipeline output (same convention as Agent/Task/Tool afterRun).
  async function finalizeIteration(input: unknown, output: unknown, startedAt: number): Promise<unknown> {
    const a = active!
    const index = a.iteration + 1
    await ctx.store.addLoopIteration({
      id: uuidv7(),
      loopId: a.loopId,
      index,
      input,
      output,
      startedAt,
      completedAt: Date.now(),
    })
    await ctx.store.updateLoop(a.loopId, { iterations: index })
    const after = await hooks.onIterationEnd?.({ loopId: a.loopId, iteration: index, output })
    const finalOutput = after ? after.output : output
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
      () => runPipelineOnce(input),
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
    execute: async ({ pipeline, input }): Promise<unknown> => {
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
    },
  }

  const iterateLoop: ToolDefinition<IterateLoopArgs, unknown> = {
    name: 'core_iterate_loop',
    description:
      'Re-run the SAME pipeline for another iteration, optionally steering it with `feedback`. ' +
      'Use after judging the previous output. Returns the new output.',
    schema: iterateLoopSchema,
    execute: async ({ feedback }): Promise<unknown> => {
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
    },
  }

  const finishLoop: ToolDefinition<FinishLoopArgs, unknown> = {
    name: 'core_finish_loop',
    description: 'Finish the active loop, recording your final judged result.',
    schema: finishLoopSchema,
    execute: async ({ result }): Promise<unknown> => {
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
    },
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
  }
}
