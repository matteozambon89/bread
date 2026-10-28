import { generateImage } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import { decisionLabel, resolveDecisionClient, toHostQuestion } from './decision.js'
import { runWithOnErrorRetry } from './hooks.js'
import { resolveImageModel } from './image.js'
import type { FileOutput } from './storage/blob-store.js'
import type { BreadCrumb, LoopHostLink, PipelineCheckpointParent, PipelineStep, Principal, RunOptions, SupervisorCheckpointParent } from './types.js'
import { BreadError } from './types.js'
import { runAgent } from './runner.js'
import type { RunnerContext } from './runner.js'
import type { CheckpointRecord } from './storage/store.js'

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
  // Copied onto every nested agent run. Never read from step input or tool args.
  principal?: Principal
  // One id per pipeline invocation (UUIDv7), minted here when absent. Every
  // step runId is `${pipelineRunId}:${pipelineId}:${index}`, so two runs of the
  // same pipeline never share a step id and a step id cannot be guessed from
  // the pipeline name. Nested arms and resume pass the original one on.
  pipelineRunId?: string
  // Copied onto every frame this run creates. Set while continuing a loop
  // iteration whose host is chain-suspended, so a later suspension keeps the link.
  hostLoop?: LoopHostLink
}

// Returned when a loop iteration's outermost frame finishes unsuspended.
// The caller writes the iteration row and continues the host.
export interface FinishedLoopFrame {
  hostLoop: LoopHostLink
  output: unknown
  // Present when the finished frame also carries a delegation link. The host
  // run is continued first; the supervisor runs only if the host has no parent.
  supervisor?: SupervisorCheckpointParent
}

// The pipeline frame finished and its only continuation is a delegation that
// was stored beside the frame instead of replacing it.
export interface FinishedSupervisorFrame {
  output: unknown
  supervisor: SupervisorCheckpointParent
}

interface PipelineResult {
  output: unknown
  decisionLabel?: string
  suspended: boolean
}

export async function* runPipeline(opts: PipelineRunOpts): AsyncGenerator<BreadCrumb, PipelineResult> {
  const { pipelineId, steps, input, ctx, baseIndex = 0 } = opts
  const pipelineRunId = opts.pipelineRunId ?? uuidv7()
  let current: unknown = input
  // Kept off `current` so the next step still sees the pre-decision value.
  // A branch with no `on` reads it, including after HITL and from inside an arm.
  let lastDecision = opts.decisionLabel

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    const index = baseIndex + i
    const stepRunId = stepRunIdOf(pipelineRunId, pipelineId, index)

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
      pipelineRunId,
      stepIndex: index,
      stepAgentId: getStepAgentId(step),
      remainingSteps: steps.slice(i + 1),
      ...(lastDecision !== undefined ? { decisionLabel: lastDecision } : {}),
      ...(opts.outer ? { outer: opts.outer } : {}),
      ...(opts.hostLoop ? { hostLoop: opts.hostLoop } : {}),
    })

    let output: unknown
    let suspended = false

    if (step.type === 'agent') {
      const runOpts: RunOptions = {
        ...(step.skill ? { skill: step.skill } : {}),
        ...(opts.principal ? { principal: opts.principal } : {}),
        _parent: stepParent(),
      }
      for await (const crumb of runAgent(step.agentId, current, runOpts, ctx)) {
        yield crumb
        if (crumb.type === 'agent:run:end') output = crumb.output
        if (crumb.type === 'human:required') suspended = true
      }
    } else if (step.type === 'parallel') {
      const res = yield* runParallelSteps(step.steps, current, ctx, pipelineId, pipelineRunId, index, {
        remainingSteps: steps.slice(i + 1),
        ...(lastDecision !== undefined ? { decisionLabel: lastDecision } : {}),
        ...(opts.outer ? { outer: opts.outer } : {}),
        ...(opts.hostLoop ? { hostLoop: opts.hostLoop } : {}),
        ...(opts.principal ? { principal: opts.principal } : {}),
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
        for await (const crumb of runAgent(
          step.agentId,
          items[j],
          { _parent: parent, ...(opts.principal ? { principal: opts.principal } : {}) },
          ctx,
        )) {
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
    } else if (step.type === 'image') {
      // A string is a text prompt. The object is the AI SDK GenerateImagePrompt,
      // so an editor such as Topaz can receive prompt.images (it ignores text).
      const prompt = imagePromptFrom(current)
      if (!prompt) {
        throw new BreadError(
          `Pipeline "${pipelineId}" step ${index} image prompt must be a string or { text?, images, mask? }.`,
          'IMAGE_PROMPT',
          { pipelineId, stepIndex: index },
        )
      }
      if (!ctx.blobStore) {
        throw new BreadError(
          `Pipeline "${pipelineId}" step ${index} is an image step but no blobStore is configured — see docs/store.md#blob-storage`,
          'BLOB_STORE_NOT_CONFIGURED',
          { pipelineId, stepIndex: index },
        )
      }
      const model = await resolveImageModel(ctx.image, step.provider, step.model)
      let image: Awaited<ReturnType<typeof generateImage>>['image']
      try {
        const generated = await generateImage({
          model,
          prompt,
          n: 1,
          maxRetries: 0,
          ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
        })
        image = generated.image
      } catch (err) {
        // Same shape as toBreadError: the provider message must survive the
        // chunked transport, which hides anything that is not a BreadError.
        throw imageStepError(err, pipelineId, index)
      }
      const { url } = await ctx.blobStore.put(image.uint8Array, { mimeType: image.mediaType })
      const sessionId = await invocationSession(ctx, pipelineRunId, opts.principal)
      const file: FileOutput = { kind: 'file', uri: url, mimeType: image.mediaType }
      yield {
        type: 'file:generated',
        agentId: 'image',
        runId: stepRunId,
        sessionId,
        uri: url,
        mimeType: image.mediaType,
        timestamp: Date.now(),
      }
      output = file
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
          pipelineRunId,
          stepIndex: index,
          stepAgentId: 'branch',
          remainingSteps: steps.slice(i + 1),
          ...(lastDecision !== undefined ? { decisionLabel: lastDecision } : {}),
          ...(opts.outer ? { outer: opts.outer } : {}),
          ...(opts.hostLoop ? { hostLoop: opts.hostLoop } : {}),
        }
        const driven = yield* runPipeline({
          pipelineId: `${pipelineId}:${index}:branch`,
          pipelineRunId,
          steps: taken.arm,
          input: current,
          ctx,
          ...(lastDecision !== undefined ? { decisionLabel: lastDecision } : {}),
          ...(opts.hostLoop ? { hostLoop: opts.hostLoop } : {}),
          ...(opts.principal ? { principal: opts.principal } : {}),
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

// The step's own runId. Also the key the HTTP transports register a live
// step under, so it must be unique per invocation.
function stepRunIdOf(pipelineRunId: string, pipelineId: string, index: number): string {
  return `${pipelineRunId}:${pipelineId}:${index}`
}

function imageStepError(err: unknown, pipelineId: string, stepIndex: number): BreadError {
  if (err instanceof BreadError) return err
  return new BreadError(
    err instanceof Error ? err.message : String(err),
    'AGENT_ERROR',
    { pipelineId, stepIndex },
    err,
  )
}

// One session per invocation, keyed by pipelineRunId, so every file:generated
// row from this run cascades together. Parallel image steps can race the insert.
async function invocationSession(
  ctx: RunnerContext,
  pipelineRunId: string,
  principal: Principal | undefined,
): Promise<string> {
  const existing = await ctx.store.getSession(pipelineRunId)
  if (existing) return existing.id
  try {
    const created = await ctx.store.createSession({
      id: pipelineRunId,
      ...(principal ? { principal } : {}),
    })
    return created.id
  } catch (err) {
    const raced = await ctx.store.getSession(pipelineRunId)
    if (raced) return raced.id
    throw err
  }
}

type ImagePrompt = Parameters<typeof generateImage>[0]['prompt']
type ImageData = string | Uint8Array | ArrayBuffer

function isImageData(value: unknown): value is ImageData {
  return typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer
}

// String, or exactly the GenerateImagePrompt object. Extra keys stay IMAGE_PROMPT
// so a plain agent object is not mistaken for a source image.
function imagePromptFrom(value: unknown): ImagePrompt | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'text' && key !== 'images' && key !== 'mask') return undefined
  }
  if (!Array.isArray(record.images) || !record.images.every(isImageData)) return undefined
  if ('text' in record && typeof record.text !== 'string') return undefined
  if ('mask' in record && !isImageData(record.mask)) return undefined
  const prompt: Exclude<ImagePrompt, string> = { images: record.images }
  if (typeof record.text === 'string') prompt.text = record.text
  if ('mask' in record && isImageData(record.mask)) prompt.mask = record.mask
  return prompt
}

function getStepAgentId(step: PipelineStep): string {
  if (step.type === 'agent' || step.type === 'map') return step.agentId
  if (step.type === 'decision') return 'decision'
  if (step.type === 'image') return 'image'
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
// A loop worker's parent is the iteration frame; the parallel frame is on the
// loop host. Walk outer first, then that host, and return the checkpoint that
// owns the frame so the caller saves that row.
async function findParallelFrame(
  ctx: RunnerContext,
  checkpoint: CheckpointRecord,
  pipelineId: string,
  stepIndex: number,
  seen = new Set<string>(),
): Promise<{ checkpoint: CheckpointRecord; frame: PipelineCheckpointParent } | undefined> {
  if (seen.has(checkpoint.id)) return undefined
  seen.add(checkpoint.id)
  if (checkpoint.parent?.kind !== 'pipeline') return undefined
  let frame: PipelineCheckpointParent | undefined = checkpoint.parent
  while (frame) {
    if (frame.parallel && frame.pipelineId === pipelineId && frame.stepIndex === stepIndex) {
      return { checkpoint, frame }
    }
    frame = frame.outer
  }
  const links: LoopHostLink[] = []
  frame = checkpoint.parent
  while (frame) {
    if (frame.hostLoop) links.push(frame.hostLoop)
    frame = frame.outer
  }
  for (const link of links) {
    if (seen.has(link.checkpointId)) continue
    const host = await ctx.store.getCheckpoint(link.checkpointId)
    if (!host) continue
    const found = await findParallelFrame(ctx, host, pipelineId, stepIndex, seen)
    if (found) return found
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
  pipelineRunId: string,
  stepIndex: number,
  outer: {
    remainingSteps: PipelineStep[]
    decisionLabel?: string
    outer?: PipelineCheckpointParent
    principal?: Principal
    hostLoop?: LoopHostLink
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
      pipelineRunId,
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
      ...(outer.hostLoop ? { hostLoop: outer.hostLoop } : {}),
    }
    try {
      // for-await drops the return value. That value is the slot's label, and
      // it has to join the accumulator before this generator is discarded.
      const gen = runPipeline({
        pipelineId: subId,
        pipelineRunId,
        steps: [step],
        input,
        ctx,
        ...(outer.decisionLabel !== undefined ? { decisionLabel: outer.decisionLabel } : {}),
        ...(outer.hostLoop ? { hostLoop: outer.hostLoop } : {}),
        ...(outer.principal ? { principal: outer.principal } : {}),
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
      if (!cp) continue
      const hit = await findParallelFrame(ctx, cp, pipelineId, stepIndex)
      if (!hit?.frame.parallel) continue
      hit.frame.parallel.settledOutputs = outputs.slice()
      hit.frame.parallel.pendingCheckpointIds = suspendedCheckpoints.slice()
      writeDecisionLabel(hit.frame, joined)
      await ctx.store.saveCheckpoint(hit.checkpoint)
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
  principal?: Principal,
): AsyncGenerator<BreadCrumb, FinishedLoopFrame | FinishedSupervisorFrame | undefined> {
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
      for await (const crumb of runAgent(
        agentId,
        remainingItems[j],
        { _parent: itemParent, ...(principal ? { principal } : {}) },
        ctx,
      )) {
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
      // Concurrent resumes of sibling branches can race these
      // read-modify-writes; sequential resumes are correct. Move the merge
      // into a store-side atomic update if concurrent resumes ever matter.
      for (const id of stillPending) {
        const cp = await ctx.store.getCheckpoint(id)
        if (!cp) continue
        const hit = await findParallelFrame(ctx, cp, parent.pipelineId, parent.stepIndex)
        if (!hit?.frame.parallel) continue
        hit.frame.parallel.settledOutputs[branchIndex] = stepOutput
        writeDecisionLabel(
          hit.frame,
          joinSlotLabel(hit.frame.parallel.incomingLabel, hit.frame.decisionLabel, parent.decisionLabel, {
            pipelineId: hit.frame.pipelineId,
            stepIndex: hit.frame.stepIndex,
          }),
        )
        await ctx.store.saveCheckpoint(hit.checkpoint)
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
    runId: stepRunIdOf(parent.pipelineRunId, parent.pipelineId, parent.stepIndex),
    output: stepOutput,
    timestamp: Date.now(),
  }
  yield endCrumb

  const hostLoop = hostLoopOf(parent)
  const driven = hostLoop
    ? yield* runRemainingWithLoopError(parent, stepOutput, ctx, carriedLabel, principal, hostLoop)
    : yield* runPipeline({
        pipelineId: parent.pipelineId,
        pipelineRunId: parent.pipelineRunId,
        steps: parent.remainingSteps,
        input: stepOutput,
        ctx,
        baseIndex: parent.stepIndex + 1,
        ...(carriedLabel !== undefined ? { decisionLabel: carriedLabel } : {}),
        ...(parent.outer ? { outer: parent.outer } : {}),
        ...(principal ? { principal } : {}),
      })
  // A later step suspended in this same iteration: its new checkpoint carries
  // hostLoop. Do not write the iteration row or continue the host.
  if (driven.suspended) return
  if (parent.outer) {
    return yield* continuePipelineParent(parent.outer, driven.output, ctx, driven.decisionLabel, principal)
  }
  if (parent.hostLoop) {
    return {
      hostLoop: parent.hostLoop,
      output: driven.output,
      ...(parent.supervisor ? { supervisor: parent.supervisor } : {}),
    }
  }
  if (parent.supervisor) return { output: driven.output, supervisor: parent.supervisor }
}

type RemainingBoxed =
  | { kind: 'done'; crumbs: BreadCrumb[]; result: PipelineResult }
  | { kind: 'recover'; output: unknown }

// Remaining steps of a resumed loop iteration. Recover substitutes the
// iteration output. Retry re-runs only these steps. LOOP_SUSPENDED and a
// human suspend skip onError and leave the iteration open.
async function* runRemainingWithLoopError(
  parent: PipelineCheckpointParent,
  stepOutput: unknown,
  ctx: RunnerContext,
  carriedLabel: string | undefined,
  principal: Principal | undefined,
  hostLoop: LoopHostLink,
): AsyncGenerator<BreadCrumb, PipelineResult> {
  const detail = await ctx.store.getLoop(hostLoop.loopId)
  const loopCfg = detail ? ctx.agents.get(detail.loop.agentId)?.config.loop : undefined
  const hooks = loopCfg?.hooks ?? {}
  const released: BreadCrumb[] = []
  let outcome: RemainingBoxed
  try {
    outcome = await runWithOnErrorRetry<RemainingBoxed>(
      async () => {
        const crumbs: BreadCrumb[] = []
        const gen = runPipeline({
          pipelineId: parent.pipelineId,
          pipelineRunId: parent.pipelineRunId,
          steps: parent.remainingSteps,
          input: stepOutput,
          ctx,
          baseIndex: parent.stepIndex + 1,
          ...(carriedLabel !== undefined ? { decisionLabel: carriedLabel } : {}),
          ...(parent.outer ? { outer: parent.outer } : {}),
          hostLoop,
          ...(principal ? { principal } : {}),
        })
        try {
          let next = await gen.next()
          while (!next.done) {
            crumbs.push(next.value)
            next = await gen.next()
          }
          return { kind: 'done', crumbs, result: next.value }
        } catch (err) {
          if (err instanceof BreadError && err.code === 'LOOP_SUSPENDED') released.push(...crumbs)
          throw err
        }
      },
      async (error) => {
        const resolution = await Promise.resolve(
          hooks.onError?.({ loopId: hostLoop.loopId, iteration: hostLoop.iteration, error }),
        )
        if (resolution?.action === 'recover') {
          return { action: 'recover', output: { kind: 'recover', output: resolution.output } }
        }
        if (resolution?.action === 'fail' || resolution?.action === 'retry') return resolution
        return undefined
      },
      (err) =>
        err instanceof BreadError
          ? err
          : new BreadError(
              err instanceof Error ? err.message : String(err),
              'LOOP_ERROR',
              { loopId: hostLoop.loopId },
              err,
            ),
      loopCfg?.errorHandling?.retry,
    )
  } catch (err) {
    for (const crumb of released) yield crumb
    throw err
  }
  if (outcome.kind === 'recover') return { output: outcome.output, suspended: false }
  for (const crumb of outcome.crumbs) yield crumb
  return outcome.result
}

function hostLoopOf(parent: PipelineCheckpointParent): LoopHostLink | undefined {
  let frame: PipelineCheckpointParent | undefined = parent
  let link: LoopHostLink | undefined
  while (frame) {
    if (frame.hostLoop) link = frame.hostLoop
    frame = frame.outer
  }
  return link
}
