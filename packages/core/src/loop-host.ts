import type { RunnerContext } from './runner-types.js'
import type { CheckpointRecord } from './storage/store.js'
import type { CheckpointParent, LoopHostLink, PipelineCheckpointParent } from './types.js'
import { BreadError } from './types.js'

// The human:required checkpoint is often not this loop's pipeline frame.
// A delegated leaf's parent is the supervisor checkpoint; a nested loop's
// leaf already carries that inner host's link. Follow those links to the
// checkpoint whose pipeline chain is this loop, and attach only there.
export async function locateLoopPipelineCheckpoint(
  ctx: RunnerContext,
  startId: string,
  loopId: string,
): Promise<CheckpointRecord | undefined> {
  const seen = new Set<string>()
  let currentId: string | undefined = startId
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const cp = await ctx.store.getCheckpoint(currentId)
    const parent = cp?.parent
    if (!parent) return undefined
    if (parent.kind === 'supervisor') {
      currentId = parent.checkpointId
      continue
    }
    if (parent.kind !== 'pipeline') return undefined
    if (chainHasPipeline(parent, loopId)) return cp
    const nextHost = differentHostLoop(parent, loopId)
    if (!nextHost) return undefined
    currentId = nextHost
  }
  return undefined
}

// Keep a host link that already belongs to another loop. Replacing it would
// resume the outer iteration from the inner frame and leave the inner host
// pending. The outer link belongs on the inner host checkpoint's parent.
export function attachHostLoop(
  parent: PipelineCheckpointParent,
  link: LoopHostLink,
): PipelineCheckpointParent {
  if (parent.outer) return { ...parent, outer: attachHostLoop(parent.outer, link) }
  if (parent.hostLoop && parent.hostLoop.loopId !== link.loopId) return parent
  return { ...parent, hostLoop: link }
}

// A later suspension in the same iteration replaces the worker checkpoint.
// Point every loop host above this leaf at the checkpoint the client can resume.
export async function retargetLoopHostPending(ctx: RunnerContext, leafId: string): Promise<void> {
  const seen = new Set<string>()
  const hostIds: string[] = []
  let current: string | undefined = leafId
  while (current && !seen.has(current)) {
    seen.add(current)
    const cp = await ctx.store.getCheckpoint(current)
    const parent = cp?.parent
    if (!parent) break
    if (parent.kind === 'supervisor') {
      current = parent.checkpointId
      continue
    }
    if (parent.kind !== 'pipeline') break
    let frame: PipelineCheckpointParent | undefined = parent
    let nextHost: string | undefined
    while (frame) {
      if (frame.hostLoop) {
        hostIds.push(frame.hostLoop.checkpointId)
        nextHost = frame.hostLoop.checkpointId
      }
      frame = frame.outer
    }
    current = nextHost
  }

  const leaf = await ctx.store.getCheckpoint(leafId)
  if (!leaf) return
  const unique = [...new Set(hostIds)]
  for (const hostId of unique) {
    if (hostId === leafId) continue
    const host = await ctx.store.getCheckpoint(hostId)
    if (!host?.pending || host.pending.length !== 1) continue
    if (host.toolName !== 'core_start_loop' && host.toolName !== 'core_iterate_loop') continue
    const pending = host.pending[0]!
    if (pending.childCheckpointId === leafId && pending.subAgentId === leaf.agentId) continue
    await ctx.store.saveCheckpoint({
      ...host,
      pending: [{ ...pending, childCheckpointId: leafId, subAgentId: leaf.agentId }],
    })
  }
}

export async function markLoopFailed(ctx: RunnerContext, loopId: string): Promise<void> {
  const detail = await ctx.store.getLoop(loopId)
  if (!detail || detail.loop.status !== 'running') return
  await ctx.store.updateLoop(loopId, { status: 'failed', completedAt: Date.now() })
}

// The worker row still exists when this runs. Delete a host and fail its loop
// only when every pending child is already gone or is the failing id. A sibling
// that is still stored keeps the host and the loop running; only the failing
// id is dropped. The same rule applies to that host's parent.
export async function dropPendingLoopHosts(
  ctx: RunnerContext,
  parent: CheckpointParent | undefined,
  failingChildId: string,
  seen = new Set<string>(),
): Promise<void> {
  if (!parent) return
  if (parent.kind === 'supervisor') {
    if (seen.has(parent.checkpointId)) return
    seen.add(parent.checkpointId)
    const supervisor = await ctx.store.getCheckpoint(parent.checkpointId)
    if (supervisor?.parent) await dropPendingLoopHosts(ctx, supervisor.parent, failingChildId, seen)
    return
  }
  const links: LoopHostLink[] = []
  let frame: PipelineCheckpointParent | undefined = parent
  while (frame) {
    if (frame.hostLoop) links.push(frame.hostLoop)
    frame = frame.outer
  }
  for (const link of links) {
    if (seen.has(link.checkpointId)) continue
    seen.add(link.checkpointId)
    const host = await ctx.store.getCheckpoint(link.checkpointId)
    if (!host) continue
    const hostParent = host.parent
    const pending = host.pending ?? []
    const liveOther = []
    for (const entry of pending) {
      if (entry.childCheckpointId === failingChildId) continue
      if (await ctx.store.getCheckpoint(entry.childCheckpointId)) liveOther.push(entry)
    }
    if (liveOther.length === 0) {
      await ctx.store.deleteCheckpoint(host.id)
      await markLoopFailed(ctx, link.loopId)
    } else if (liveOther.length !== pending.length) {
      await ctx.store.saveCheckpoint({ ...host, pending: liveOther })
    }
    if (hostParent) await dropPendingLoopHosts(ctx, hostParent, failingChildId, seen)
  }
}

export function missingHostCheckpoint(checkpointId: string, loopId: string): BreadError {
  return new BreadError(
    `Loop host checkpoint not found or already resumed: ${checkpointId}`,
    'CHECKPOINT_NOT_FOUND',
    { checkpointId, loopId },
  )
}

function chainHasPipeline(parent: PipelineCheckpointParent, pipelineId: string): boolean {
  let frame: PipelineCheckpointParent | undefined = parent
  while (frame) {
    if (frame.pipelineId === pipelineId) return true
    frame = frame.outer
  }
  return false
}

function differentHostLoop(parent: PipelineCheckpointParent, loopId: string): string | undefined {
  let frame: PipelineCheckpointParent | undefined = parent
  let hostId: string | undefined
  while (frame) {
    if (frame.hostLoop && frame.hostLoop.loopId !== loopId) hostId = frame.hostLoop.checkpointId
    frame = frame.outer
  }
  return hostId
}
