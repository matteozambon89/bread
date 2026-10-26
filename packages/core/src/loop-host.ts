import type { RunnerContext } from './runner-types.js'
import type { CheckpointRecord, PendingDelegation } from './storage/store.js'
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
// Point every loop host above this leaf at a checkpoint that still exists.
// Returns whether a loop host sits above the leaf (even if its pending list
// already named it) so the caller can re-yield that leaf's human:required.
export async function retargetLoopHostPending(ctx: RunnerContext, leafId: string): Promise<boolean> {
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

  const unique = [...new Set(hostIds)]
  const leaf = await ctx.store.getCheckpoint(leafId)
  if (!leaf || unique.length === 0) return false
  const releasing = ctx.releasingLoopWorkerId
  for (const hostId of unique) {
    if (hostId === leafId) continue
    const host = await ctx.store.getCheckpoint(hostId)
    if (!host?.pending?.length) continue
    if (host.toolName !== 'core_start_loop' && host.toolName !== 'core_iterate_loop') continue
    const live: PendingDelegation[] = []
    for (const entry of host.pending) {
      if (entry.childCheckpointId === releasing) continue
      if (entry.childCheckpointId === leafId) {
        live.push(entry)
        continue
      }
      if (await ctx.store.getCheckpoint(entry.childCheckpointId)) live.push(entry)
    }
    const hasLeaf = live.some((entry) => entry.childCheckpointId === leafId)
    const next = hasLeaf
      ? live
      : [
          ...live,
          {
            toolCallId: host.pending[0]!.toolCallId,
            childCheckpointId: leafId,
            subAgentId: leaf.agentId,
          },
        ]
    if (samePending(host.pending, next)) continue
    await ctx.store.saveCheckpoint({ ...host, pending: next })
  }
  return true
}

export async function loopHostLinkOf(
  ctx: RunnerContext,
  parent: CheckpointParent | undefined,
): Promise<LoopHostLink | undefined> {
  const seen = new Set<string>()
  let current = parent
  while (current) {
    if (current.kind === 'supervisor') {
      if (seen.has(current.checkpointId)) return undefined
      seen.add(current.checkpointId)
      const supervisor = await ctx.store.getCheckpoint(current.checkpointId)
      current = supervisor?.parent
      continue
    }
    let frame: PipelineCheckpointParent | undefined = current
    while (frame) {
      if (frame.hostLoop) return frame.hostLoop
      frame = frame.outer
    }
    return undefined
  }
  return undefined
}

export async function failOpenLoops(
  ctx: RunnerContext,
  loopIds: readonly string[],
  checkpointIds: readonly string[],
): Promise<void> {
  const loops = new Set(loopIds.filter((id) => id.length > 0))
  const toDelete = new Set(checkpointIds.filter((id) => id.length > 0))
  const seen = new Set<string>()
  for (const leafId of [...toDelete]) await collectLoopChain(ctx, leafId, loops, toDelete, seen)
  await collectHostsPendingOn(ctx, loops, toDelete)
  for (const loopId of loops) await markLoopFailed(ctx, loopId)
  for (const id of toDelete) await ctx.store.deleteCheckpoint(id)
}

// Follow supervisor and hostLoop links from a leaf. An inner host that is not
// in the caller's id list is still this suspension: fail its loop and delete
// it. Checkpoints off the chain are left alone.
async function collectLoopChain(
  ctx: RunnerContext,
  id: string,
  loops: Set<string>,
  toDelete: Set<string>,
  seen: Set<string>,
): Promise<void> {
  if (!id || seen.has(id)) return
  seen.add(id)
  const parent = (await ctx.store.getCheckpoint(id))?.parent
  if (!parent) return
  if (parent.kind === 'supervisor') {
    await collectLoopChain(ctx, parent.checkpointId, loops, toDelete, seen)
    return
  }
  const hosts: LoopHostLink[] = []
  let frame: PipelineCheckpointParent | undefined = parent
  while (frame) {
    if (frame.hostLoop) hosts.push(frame.hostLoop)
    frame = frame.outer
  }
  for (const link of hosts) {
    loops.add(link.loopId)
    toDelete.add(link.checkpointId)
    await collectLoopChain(ctx, link.checkpointId, loops, toDelete, seen)
  }
}

// A host whose only pending children are leaves this failure is deleting has
// no live iteration left, even when the leaf no longer carries hostLoop.
async function collectHostsPendingOn(
  ctx: RunnerContext,
  loops: Set<string>,
  toDelete: Set<string>,
): Promise<void> {
  const all = await ctx.store.listCheckpoints({ executionId: ctx.executionId })
  let grew = true
  while (grew) {
    grew = false
    for (const cp of all) {
      if (toDelete.has(cp.id)) continue
      if (cp.toolName !== 'core_start_loop' && cp.toolName !== 'core_iterate_loop') continue
      const pending = cp.pending ?? []
      if (pending.length === 0) continue
      const allGone = pending.every(
        (entry) => toDelete.has(entry.childCheckpointId) || !all.some((row) => row.id === entry.childCheckpointId),
      )
      if (!allGone) continue
      toDelete.add(cp.id)
      grew = true
      const running = await ctx.store.listLoops({
        sessionId: cp.sessionId,
        agentId: cp.agentId,
        status: 'running',
      })
      for (const loop of running) {
        if (loop.runId === cp.runId) loops.add(loop.id)
      }
    }
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

// True when this parent is a loop iteration whose hostLoop is not saved yet.
// A later suspend in the same iteration already carries the link.
export async function loopIterationAwaitingHost(
  ctx: RunnerContext,
  parent: CheckpointParent | undefined,
  seen = new Set<string>(),
): Promise<boolean> {
  if (!parent) return false
  if (parent.kind === 'supervisor') {
    if (seen.has(parent.checkpointId)) return false
    seen.add(parent.checkpointId)
    const supervisor = await ctx.store.getCheckpoint(parent.checkpointId)
    return loopIterationAwaitingHost(ctx, supervisor?.parent, seen)
  }
  const pipelineIds: string[] = []
  let frame: PipelineCheckpointParent | undefined = parent
  while (frame) {
    if (frame.hostLoop) return false
    pipelineIds.push(frame.pipelineId)
    frame = frame.outer
  }
  for (const pipelineId of pipelineIds) {
    const detail = await ctx.store.getLoop(pipelineId)
    if (detail?.loop.status === 'running') return true
  }
  return false
}

export function missingHostCheckpoint(checkpointId: string, loopId: string): BreadError {
  return new BreadError(
    `Loop host checkpoint not found or already resumed: ${checkpointId}`,
    'CHECKPOINT_NOT_FOUND',
    { checkpointId, loopId },
  )
}

function samePending(left: PendingDelegation[], right: PendingDelegation[]): boolean {
  if (left.length !== right.length) return false
  return left.every(
    (entry, index) =>
      entry.childCheckpointId === right[index]?.childCheckpointId &&
      entry.subAgentId === right[index]?.subAgentId &&
      entry.toolCallId === right[index]?.toolCallId,
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
