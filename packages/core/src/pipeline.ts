import type { BreadCrumb, PipelineCheckpointParent, PipelineStep, RunOptions } from './types.js'
import { BreadError } from './types.js'
import { runAgent } from './runner.js'
import type { RunnerContext } from './runner.js'

export interface PipelineRunOpts {
  pipelineId: string
  steps: PipelineStep[]
  input: unknown
  ctx: RunnerContext
  // Continuation numbering offset: on resume, crumb stepIndex/runId numbering
  // picks up after the suspended step instead of restarting at 0 (which would
  // collide with the original run's step runIds).
  baseIndex?: number
  // Set when this invocation runs a single parallel-branch step: the checkpoint
  // parent template carrying the OUTER continuation (remaining steps after the
  // parallel step) plus this branch's position. Sibling data is filled in by
  // runParallelSteps after every branch settles.
  branchParent?: PipelineCheckpointParent
}

export async function* runPipeline(opts: PipelineRunOpts): AsyncGenerator<BreadCrumb> {
  const { pipelineId, steps, input, ctx, baseIndex = 0, branchParent } = opts
  let current: unknown = input

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    const index = baseIndex + i
    const stepRunId = `${pipelineId}:${index}`

    const startCrumb: BreadCrumb = {
      type: 'pipeline:step:start',
      pipelineId,
      stepIndex: index,
      agentId: getStepAgentId(step),
      runId: stepRunId,
      timestamp: Date.now(),
    }
    yield startCrumb

    // The checkpoint parent for a suspension inside this step: a parallel
    // branch inherits the outer continuation; a top-level step's continuation
    // is simply the steps after it.
    const stepParent = (): PipelineCheckpointParent =>
      branchParent ?? {
        kind: 'pipeline',
        pipelineId,
        stepIndex: index,
        stepAgentId: getStepAgentId(step),
        remainingSteps: steps.slice(i + 1),
      }

    let output: unknown
    let suspended = false

    if (step.type === 'agent') {
      const runOpts: RunOptions = {
        ...(step.skill ? { skill: step.skill } : {}),
        _parent: stepParent(),
      }
      for await (const crumb of runAgent(step.agentId, current, runOpts, ctx)) {
        yield crumb
        if (crumb.type === 'agent:run:end') output = crumb.output
        if (crumb.type === 'human:required') suspended = true
      }
    } else if (step.type === 'parallel') {
      const res = yield* runParallelSteps(step.steps, current, ctx, pipelineId, index, {
        remainingSteps: steps.slice(i + 1),
        nested: branchParent !== undefined,
      })
      output = res.output
      suspended = res.suspended
    } else if (step.type === 'map') {
      // `map` fans out: input must be an array; each element runs through agentId
      const items = Array.isArray(current) ? current : [current]
      const results: unknown[] = []
      for (let j = 0; j < items.length; j++) {
        const parent: PipelineCheckpointParent = {
          ...stepParent(),
          map: {
            agentId: step.agentId,
            settledOutputs: results.slice(),
            remainingItems: items.slice(j + 1),
          },
        }
        for await (const crumb of runAgent(step.agentId, items[j], { _parent: parent }, ctx)) {
          yield crumb
          if (crumb.type === 'agent:run:end') results.push(crumb.output)
          if (crumb.type === 'human:required') suspended = true
        }
        if (suspended) break
      }
      output = results
    }

    // A suspended step ends the stream at human:required — same contract as a
    // single-agent run. The checkpoint's parent linkage (persisted atomically
    // with it via RunOptions._parent) lets resume continue the remaining steps.
    if (suspended) return

    const endCrumb: BreadCrumb = {
      type: 'pipeline:step:end',
      pipelineId,
      stepIndex: index,
      agentId: getStepAgentId(step),
      runId: stepRunId,
      output,
      timestamp: Date.now(),
    }
    yield endCrumb

    current = output
  }
}

function getStepAgentId(step: PipelineStep): string {
  if (step.type === 'agent') return step.agentId
  if (step.type === 'map') return step.agentId
  return 'parallel'
}

interface ParallelResult {
  output?: unknown[]
  suspended: boolean
}

async function* runParallelSteps(
  branchSteps: PipelineStep[],
  input: unknown,
  ctx: RunnerContext,
  pipelineId: string,
  stepIndex: number,
  outer: { remainingSteps: PipelineStep[]; nested: boolean },
): AsyncGenerator<BreadCrumb, ParallelResult> {
  type QueueItem = BreadCrumb | null

  const queue: QueueItem[] = []
  const failures: unknown[] = []
  const outputs: (unknown | null)[] = branchSteps.map(() => null)
  const suspendedCheckpoints: string[] = []
  const heldHumanRequired: BreadCrumb[] = []
  let pending = branchSteps.length
  let resolver: (() => void) | null = null

  function push(item: QueueItem) {
    queue.push(item)
    resolver?.()
    resolver = null
  }

  async function drain(step: PipelineStep, branchIndex: number) {
    const subId = `${pipelineId}:${stepIndex}:parallel:${branchIndex}`
    // ponytail: a parallel step nested inside another parallel branch gets no
    // continuation linkage — a suspension there resumes only the suspended
    // agent. Chain the parent records if that shape ever matters.
    const branchParent: PipelineCheckpointParent | undefined = outer.nested
      ? undefined
      : {
          kind: 'pipeline',
          pipelineId,
          stepIndex,
          stepAgentId: 'parallel',
          remainingSteps: outer.remainingSteps,
          parallel: { branchIndex, settledOutputs: [], pendingCheckpointIds: [] },
        }
    try {
      for await (const crumb of runPipeline({
        pipelineId: subId,
        steps: [step],
        input,
        ctx,
        ...(branchParent ? { branchParent } : {}),
      })) {
        if (crumb.type === 'human:required') {
          // Held back until every branch settles and the checkpoint has its
          // sibling data — a client resuming the instant it sees this crumb
          // must find complete parallel linkage, not a half-filled record.
          suspendedCheckpoints.push(crumb.checkpointId)
          heldHumanRequired.push(crumb)
          continue
        }
        if (crumb.type === 'pipeline:step:end' && crumb.pipelineId === subId) {
          outputs[branchIndex] = crumb.output
        }
        push(crumb)
      }
    } catch (err) {
      // A failed branch fails the whole parallel step — but only after every
      // sibling settles, so sibling crumbs still reach the consumer before the
      // throw below. All branches launch immediately (no bounded queue), so
      // an aborted `ctx.signal` reaches every in-flight branch's own model
      // call at once via `runAgent` — there's no separate "stop launching
      // more" step needed here (contrast `supervisor.ts`'s bounded `launch()`).
      failures.push(err)
    } finally {
      pending--
      push(null) // sentinel
    }
  }

  branchSteps.forEach((step, branchIndex) => void drain(step, branchIndex))

  while (pending > 0 || queue.length > 0) {
    while (queue.length > 0) {
      const item = queue.shift()!
      if (item !== null) yield item
    }
    if (pending > 0) {
      await new Promise<void>((r) => {
        resolver = r
      })
    }
  }

  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${branchSteps.length} parallel pipeline steps failed (pipeline "${pipelineId}", step ${stepIndex})`,
    )
  }

  if (suspendedCheckpoints.length > 0) {
    // Every branch has settled; fill in the sibling data each suspended
    // checkpoint couldn't know at suspend time. Suspended branches stay null
    // in settledOutputs until their own resume fills them. Only after this is
    // durable do the held human:required crumbs surface to the client.
    for (const checkpointId of suspendedCheckpoints) {
      const cp = await ctx.store.getCheckpoint(checkpointId)
      if (cp?.parent?.kind === 'pipeline' && cp.parent.parallel) {
        cp.parent.parallel.settledOutputs = outputs.slice()
        cp.parent.parallel.pendingCheckpointIds = suspendedCheckpoints.slice()
        await ctx.store.saveCheckpoint(cp)
      }
    }
    for (const crumb of heldHumanRequired) yield crumb
    return { suspended: true }
  }

  return { output: outputs as unknown[], suspended: false }
}

// Continues a pipeline whose step suspended for HITL, after the suspended
// sub-run has been resumed to completion. Called by resumeRun with the
// checkpoint's parent linkage and the resumed run's output; yields the rest of
// the pipeline's crumbs (and may itself suspend again — new checkpoints carry
// fresh parent linkage).
export async function* continuePipelineParent(
  parent: PipelineCheckpointParent,
  resumedOutput: unknown,
  ctx: RunnerContext,
): AsyncGenerator<BreadCrumb> {
  let stepOutput: unknown = resumedOutput

  // Finish an interrupted map fan-out: the resumed item's output joins the
  // already-settled ones, then the remaining items run.
  if (parent.map) {
    const { agentId, remainingItems } = parent.map
    const results = [...parent.map.settledOutputs, resumedOutput]
    for (let j = 0; j < remainingItems.length; j++) {
      const itemParent: PipelineCheckpointParent = {
        ...parent,
        map: {
          agentId,
          settledOutputs: results.slice(),
          remainingItems: remainingItems.slice(j + 1),
        },
      }
      let suspended = false
      for await (const crumb of runAgent(agentId, remainingItems[j], { _parent: itemParent }, ctx)) {
        yield crumb
        if (crumb.type === 'agent:run:end') results.push(crumb.output)
        if (crumb.type === 'human:required') suspended = true
      }
      if (suspended) return
    }
    stepOutput = results
  }

  // A parallel branch resolved: record its output. Only the last outstanding
  // branch's resume carries the merged output onward; earlier resumes persist
  // their output into the still-pending siblings' checkpoints and stop.
  if (parent.parallel) {
    const { branchIndex, settledOutputs, pendingCheckpointIds } = parent.parallel
    // Sibling data is written after every branch settles (always non-empty:
    // pendingCheckpointIds contains at least this branch's own id). Empty means
    // the process died mid-parallel before the linkage completed — merging
    // would silently produce wrong output, so fail loud instead.
    if (pendingCheckpointIds.length === 0) {
      throw new BreadError(
        `Pipeline "${parent.pipelineId}" lost its parallel-step state: the process suspended ` +
          `branch ${branchIndex} but exited before its sibling branches settled. The suspended ` +
          `agent run was resumed, but the pipeline cannot continue.`,
        'PIPELINE_STATE_LOST',
        { pipelineId: parent.pipelineId, stepIndex: parent.stepIndex, branchIndex },
      )
    }
    const merged = settledOutputs.slice()
    merged[branchIndex] = stepOutput

    const stillPending: string[] = []
    for (const id of pendingCheckpointIds) {
      // The resumed branch's own checkpoint was already claimed and deleted.
      if (await ctx.store.getCheckpoint(id)) stillPending.push(id)
    }
    if (stillPending.length > 0) {
      // ponytail: concurrent resumes of sibling branches can race these
      // read-modify-writes; sequential resumes are correct. Move the merge
      // into a store-side atomic update if concurrent resumes ever matter.
      for (const id of stillPending) {
        const cp = await ctx.store.getCheckpoint(id)
        if (cp?.parent?.kind === 'pipeline' && cp.parent.parallel) {
          cp.parent.parallel.settledOutputs[branchIndex] = stepOutput
          await ctx.store.saveCheckpoint(cp)
        }
      }
      return // pipeline stays suspended on the remaining branches
    }
    stepOutput = merged
  }

  // Close the suspended step (its step:end never fired), then run what remains.
  const endCrumb: BreadCrumb = {
    type: 'pipeline:step:end',
    pipelineId: parent.pipelineId,
    stepIndex: parent.stepIndex,
    agentId: parent.stepAgentId,
    runId: `${parent.pipelineId}:${parent.stepIndex}`,
    output: stepOutput,
    timestamp: Date.now(),
  }
  yield endCrumb

  yield* runPipeline({
    pipelineId: parent.pipelineId,
    steps: parent.remainingSteps,
    input: stepOutput,
    ctx,
    baseIndex: parent.stepIndex + 1,
  })
}
