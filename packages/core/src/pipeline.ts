import { decisionLabel, resolveDecisionClient, toHostQuestion } from './decision.js'
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
  // Frames that continue after this step list finishes. The innermost is
  // `outer`; each frame's own `outer` is the next one. A suspension pushes
  // this step's frame in front of them.
  outer?: PipelineCheckpointParent
  // Latest decision label from an earlier step or a resumed checkpoint. A branch
  // with no `on` reads it. An arm returns its own label so the outer run updates.
  decisionLabel?: string
}

interface PipelineResult {
  output: unknown
  decisionLabel?: string
  suspended: boolean
}

export async function* runPipeline(opts: PipelineRunOpts): AsyncGenerator<BreadCrumb, PipelineResult> {
  const { pipelineId, steps, input, ctx, baseIndex = 0 } = opts
  let current: unknown = input
  // Kept off `current` so the next step still sees the pre-decision value.
  // A branch with no `on` reads it, including after HITL and from inside an arm.
  let lastDecision = opts.decisionLabel

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

    // This step's suffix only. The branch step and each parallel slot are
    // already their own frames on `outer` — copying them here drops the inner
    // arm when a parallel frame is returned in their place.
    const stepParent = (): PipelineCheckpointParent => ({
      kind: 'pipeline',
      pipelineId,
      stepIndex: index,
      stepAgentId: getStepAgentId(step),
      remainingSteps: steps.slice(i + 1),
      ...(lastDecision !== undefined ? { decisionLabel: lastDecision } : {}),
      ...(opts.outer ? { outer: opts.outer } : {}),
    })

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
        ...(lastDecision !== undefined ? { decisionLabel: lastDecision } : {}),
        ...(opts.outer ? { outer: opts.outer } : {}),
      })
      output = res.output
      suspended = res.suspended
      if (res.decisionLabel !== undefined) lastDecision = res.decisionLabel
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
    } else if (step.type === 'decision') {
      const client = await resolveDecisionClient(ctx.decisions, step.provider, step.model)
      const response = await client.systemOne({
        state: current,
        questions: [toHostQuestion(step.question)],
      })
      const decided = decisionLabel(step.question, response.answers)
      output = { label: decided.label, answer: decided.answer }
      lastDecision = decided.label
    } else if (step.type === 'branch') {
      if (step.default === undefined) {
        throw new BreadError(
          `Pipeline "${pipelineId}" step ${index} is a branch without a default arm.`,
          'PIPELINE_BRANCH_DEFAULT',
          { pipelineId, stepIndex: index },
        )
      }
      const taken = selectArm(step, current, lastDecision, pipelineId, index)
      yield {
        type: 'pipeline:branch:taken',
        pipelineId,
        stepIndex: index,
        agentId: 'branch',
        runId: stepRunId,
        eq: taken.eq,
        caseIndex: taken.caseIndex,
        timestamp: Date.now(),
      }
      if (taken.arm.length === 0) {
        output = current
      } else {
        // The arm suffix lives on the inner frame. This frame is what remains
        // after the arm: close the branch step, then run the steps after it.
        const armOuter: PipelineCheckpointParent = {
          kind: 'pipeline',
          pipelineId,
          stepIndex: index,
          stepAgentId: 'branch',
          remainingSteps: steps.slice(i + 1),
          ...(lastDecision !== undefined ? { decisionLabel: lastDecision } : {}),
          ...(opts.outer ? { outer: opts.outer } : {}),
        }
        const driven = yield* runPipeline({
          pipelineId: `${pipelineId}:${index}:branch`,
          steps: taken.arm,
          input: current,
          ctx,
          ...(lastDecision !== undefined ? { decisionLabel: lastDecision } : {}),
          outer: armOuter,
        })
        if (driven.decisionLabel !== undefined) lastDecision = driven.decisionLabel
        output = driven.output
        suspended = driven.suspended
      }
    }

    // A suspended step ends the stream at human:required — same contract as a
    // single-agent run. The checkpoint's parent linkage (persisted atomically
    // with it via RunOptions._parent) lets resume continue the remaining steps.
    if (suspended) return pipelineResult(current, lastDecision, true)

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

    if (step.type !== 'decision') current = output
  }

  return pipelineResult(current, lastDecision, false)
}

function getStepAgentId(step: PipelineStep): string {
  if (step.type === 'agent' || step.type === 'map') return step.agentId
  if (step.type === 'decision') return 'decision'
  if (step.type === 'branch') return 'branch'
  return 'parallel'
}

interface TakenArm {
  caseIndex: number
  eq: string | null
  arm: PipelineStep[]
}

// Strict string equality, first hit. A missing path or a non-string is not a
// match, so the default arm runs. No `on` and no decision label is an error.
function selectArm(
  step: Extract<PipelineStep, { type: 'branch' }>,
  current: unknown,
  lastDecision: string | undefined,
  pipelineId: string,
  stepIndex: number,
): TakenArm {
  let label: unknown
  if (step.on !== undefined) {
    label = readPath(current, step.on)
  } else if (lastDecision === undefined) {
    throw new BreadError(
      `Pipeline "${pipelineId}" step ${stepIndex} is a branch without \`on\` and no decision step has run.`,
      'PIPELINE_BRANCH_NO_LABEL',
      { pipelineId, stepIndex },
    )
  } else {
    label = lastDecision
  }
  if (typeof label === 'string') {
    const caseIndex = step.cases.findIndex((item) => item.eq === label)
    if (caseIndex >= 0) {
      const matched = step.cases[caseIndex]!
      return { caseIndex, eq: matched.eq, arm: matched.steps }
    }
  }
  return { caseIndex: -1, eq: null, arm: step.default }
}

function readPath(value: unknown, path: string): unknown {
  let current = value
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function pipelineResult(
  output: unknown,
  decisionLabel: string | undefined,
  suspended: boolean,
): PipelineResult {
  return {
    output,
    suspended,
    ...(decisionLabel !== undefined ? { decisionLabel } : {}),
  }
}

// The parallel slot for this step sits on its own frame. Nested arms push
// frames in front of it, so the checkpoint parent is not always that frame.
function findParallelFrame(
  parent: PipelineCheckpointParent,
  pipelineId: string,
  stepIndex: number,
): PipelineCheckpointParent | undefined {
  let frame: PipelineCheckpointParent | undefined = parent
  while (frame) {
    if (frame.parallel && frame.pipelineId === pipelineId && frame.stepIndex === stepIndex) return frame
    frame = frame.outer
  }
  return undefined
}

interface ParallelResult {
  output?: unknown[]
  suspended: boolean
  decisionLabel?: string
}

// One new slot label replaces the label the parallel step was entered with.
// A second, different label is an error: slots have no order to call latest.
function joinSlotLabel(
  incoming: string | undefined,
  current: string | undefined,
  slotLabel: string | undefined,
  where: { pipelineId: string; stepIndex: number },
): string | undefined {
  if (slotLabel === undefined || slotLabel === incoming) return current
  if (current === undefined || current === incoming || current === slotLabel) return slotLabel
  throw new BreadError(
    `Pipeline "${where.pipelineId}" step ${where.stepIndex} has parallel slots with different decision labels ("${current}" and "${slotLabel}").`,
    'PIPELINE_DECISION_CONFLICT',
    { pipelineId: where.pipelineId, stepIndex: where.stepIndex },
  )
}

function writeDecisionLabel(frame: PipelineCheckpointParent, label: string | undefined): void {
  if (label === undefined) delete frame.decisionLabel
  else frame.decisionLabel = label
}

function adoptSlotLabel(frame: PipelineCheckpointParent, slotLabel: string): void {
  if (!frame.parallel) {
    frame.decisionLabel = slotLabel
    return
  }
  writeDecisionLabel(
    frame,
    joinSlotLabel(frame.parallel.incomingLabel, frame.decisionLabel, slotLabel, {
      pipelineId: frame.pipelineId,
      stepIndex: frame.stepIndex,
    }),
  )
}

async function* runParallelSteps(
  branchSteps: PipelineStep[],
  input: unknown,
  ctx: RunnerContext,
  pipelineId: string,
  stepIndex: number,
  outer: {
    remainingSteps: PipelineStep[]
    decisionLabel?: string
    outer?: PipelineCheckpointParent
  },
): AsyncGenerator<BreadCrumb, ParallelResult> {
  type QueueItem = BreadCrumb | null

  const queue: QueueItem[] = []
  const failures: unknown[] = []
  const outputs: (unknown | null)[] = branchSteps.map(() => null)
  const suspendedCheckpoints: string[] = []
  const heldHumanRequired: BreadCrumb[] = []
  let joined = outer.decisionLabel
  let conflictRecorded = false
  let pending = branchSteps.length
  let resolver: (() => void) | null = null

  // Sync on purpose: drains overlap only at awaits, and the join itself does not.
  function adoptJoined(slotLabel: string | undefined) {
    if (conflictRecorded) return
    try {
      joined = joinSlotLabel(outer.decisionLabel, joined, slotLabel, { pipelineId, stepIndex })
    } catch (err) {
      conflictRecorded = true
      failures.push(err)
    }
  }

  function push(item: QueueItem) {
    queue.push(item)
    resolver?.()
    resolver = null
  }

  async function drain(step: PipelineStep, branchIndex: number) {
    const subId = `${pipelineId}:${stepIndex}:parallel:${branchIndex}`
    const parallelFrame: PipelineCheckpointParent = {
      kind: 'pipeline',
      pipelineId,
      stepIndex,
      stepAgentId: 'parallel',
      remainingSteps: outer.remainingSteps,
      parallel: {
        branchIndex,
        settledOutputs: [],
        pendingCheckpointIds: [],
        ...(outer.decisionLabel !== undefined ? { incomingLabel: outer.decisionLabel } : {}),
      },
      ...(outer.decisionLabel !== undefined ? { decisionLabel: outer.decisionLabel } : {}),
      ...(outer.outer ? { outer: outer.outer } : {}),
    }
    try {
      // for-await drops the return value. That value is the slot's label, and
      // it has to join the accumulator before this generator is discarded.
      const gen = runPipeline({
        pipelineId: subId,
        steps: [step],
        input,
        ctx,
        ...(outer.decisionLabel !== undefined ? { decisionLabel: outer.decisionLabel } : {}),
        outer: parallelFrame,
      })
      let next = await gen.next()
      while (!next.done) {
        const crumb = next.value
        if (crumb.type === 'human:required') {
          // Held back until every branch settles and the checkpoint has its
          // sibling data — a client resuming the instant it sees this crumb
          // must find complete parallel linkage, not a half-filled record.
          suspendedCheckpoints.push(crumb.checkpointId)
          heldHumanRequired.push(crumb)
        } else {
          if (crumb.type === 'pipeline:step:end' && crumb.pipelineId === subId) {
            outputs[branchIndex] = crumb.output
          }
          push(crumb)
        }
        next = await gen.next()
      }
      if (!next.value.suspended) adoptJoined(next.value.decisionLabel)
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
      if (cp?.parent?.kind !== 'pipeline') continue
      const frame = findParallelFrame(cp.parent, pipelineId, stepIndex)
      if (!frame?.parallel) continue
      frame.parallel.settledOutputs = outputs.slice()
      frame.parallel.pendingCheckpointIds = suspendedCheckpoints.slice()
      writeDecisionLabel(frame, joined)
      await ctx.store.saveCheckpoint(cp)
    }
    for (const crumb of heldHumanRequired) yield crumb
    return { suspended: true }
  }

  return {
    output: outputs as unknown[],
    suspended: false,
    ...(joined !== undefined ? { decisionLabel: joined } : {}),
  }
}

// Continues a pipeline whose step suspended for HITL, after the suspended
// sub-run has been resumed to completion. Called by resumeRun with the
// checkpoint's parent linkage and the resumed run's output; yields the rest of
// the pipeline's crumbs (and may itself suspend again — new checkpoints carry
// fresh parent linkage). One call finishes one frame, then pops `outer`.
export async function* continuePipelineParent(
  parent: PipelineCheckpointParent,
  resumedOutput: unknown,
  ctx: RunnerContext,
  slotLabel?: string,
): AsyncGenerator<BreadCrumb> {
  if (slotLabel !== undefined) adoptSlotLabel(parent, slotLabel)
  let stepOutput: unknown = resumedOutput
  let carriedLabel = parent.decisionLabel

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
        if (cp?.parent?.kind !== 'pipeline') continue
        const frame = findParallelFrame(cp.parent, parent.pipelineId, parent.stepIndex)
        if (!frame?.parallel) continue
        frame.parallel.settledOutputs[branchIndex] = stepOutput
        writeDecisionLabel(
          frame,
          joinSlotLabel(frame.parallel.incomingLabel, frame.decisionLabel, parent.decisionLabel, {
            pipelineId: frame.pipelineId,
            stepIndex: frame.stepIndex,
          }),
        )
        await ctx.store.saveCheckpoint(cp)
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

  const driven = yield* runPipeline({
    pipelineId: parent.pipelineId,
    steps: parent.remainingSteps,
    input: stepOutput,
    ctx,
    baseIndex: parent.stepIndex + 1,
    ...(carriedLabel !== undefined ? { decisionLabel: carriedLabel } : {}),
    ...(parent.outer ? { outer: parent.outer } : {}),
  })
  if (driven.suspended || !parent.outer) return
  yield* continuePipelineParent(parent.outer, driven.output, ctx, driven.decisionLabel)
}
