import { BreadError, decodeLastOutput, type CheckpointRecord, type CrumbLogEntry, type LoopIteration, type LoopRecord, type LoopStatus, type MemoryRecord, type Principal, type Session, type SessionMessage, type TaskRunRecord, type TaskRunStatus } from '@breadai/core'

type Doc = Record<string, unknown>

function failed(): never {
  throw new BreadError('Store query failed.', 'STORE_QUERY_FAILED')
}

function text(value: unknown): string {
  if (typeof value !== 'string') failed()
  return value
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) failed()
  return value
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) failed()
  return value
}

const TAG_KEY = /^[a-z][a-z0-9_]{0,31}$/

function tagsOf(value: unknown): Record<string, string> {
  const tags: Record<string, string> = {}
  if (!Array.isArray(value)) return tags
  for (const pair of value) {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) continue
    const row = pair as { k?: unknown; v?: unknown }
    if (typeof row.k !== 'string' || typeof row.v !== 'string' || !TAG_KEY.test(row.k)) continue
    tags[row.k] = row.v
  }
  return tags
}

function principalOf(value: unknown): Principal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as { iss?: unknown; sub?: unknown; tenant?: unknown; roles?: unknown }
  if (typeof row.iss !== 'string' || typeof row.sub !== 'string') return undefined
  const principal: Principal = { iss: row.iss, sub: row.sub }
  if (typeof row.tenant === 'string') principal.tenant = row.tenant
  if (Array.isArray(row.roles) && row.roles.every((role) => typeof role === 'string')) {
    principal.roles = row.roles
  }
  return principal
}

function present<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value
}

export function toSession(doc: Doc): Session {
  const principal = principalOf(doc.principal)
  const agentId = doc.agent_id
  return {
    id: text(doc._id),
    createdAt: number(doc.created_at),
    updatedAt: number(doc.updated_at),
    tags: tagsOf(doc.tags),
    ...(typeof agentId === 'string' ? { agentId } : {}),
    ...(principal ? { principal } : {}),
  }
}

export function toMessage(doc: Doc): SessionMessage {
  const role = doc.role
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') failed()
  return {
    id: text(doc._id),
    sessionId: text(doc.session_id),
    role,
    content: doc.content,
    timestamp: number(doc.timestamp),
  }
}

export function toCheckpoint(doc: Doc): CheckpointRecord {
  const prompt = present(doc.prompt as string | null | undefined)
  const skill = present(doc.skill as string | null | undefined)
  const parent = present(doc.parent)
  const pending = present(doc.pending)
  const principal = principalOf(doc.principal)
  return {
    id: text(doc._id),
    agentId: text(doc.agent_id),
    runId: text(doc.run_id),
    sessionId: text(doc.session_id),
    executionId: text(doc.execution_id),
    toolName: text(doc.tool_name),
    toolCallId: text(doc.tool_call_id),
    schema: doc.schema,
    ...(typeof prompt === 'string' ? { prompt } : {}),
    ...(typeof skill === 'string' ? { skill } : {}),
    ...(parent != null ? { parent: parent as CheckpointRecord['parent'] } : {}),
    ...(pending != null ? { pending: pending as CheckpointRecord['pending'] } : {}),
    ...(principal ? { principal } : {}),
    createdAt: number(doc.created_at),
  }
}

export function toLoop(doc: Doc): LoopRecord {
  const decoded = decodeLastOutput(doc.last_output)
  const result = doc.result
  const completed = doc.completed_at
  return {
    id: text(doc._id),
    agentId: text(doc.agent_id),
    sessionId: text(doc.session_id),
    runId: text(doc.run_id),
    pool: strings(doc.pool),
    pipeline: strings(doc.pipeline),
    maxIterations: number(doc.max_iterations),
    status: text(doc.status) as LoopStatus,
    iterations: number(doc.iterations),
    ...(result != null ? { result } : {}),
    ...(decoded.present ? { lastOutput: decoded.value } : {}),
    startedAt: number(doc.started_at),
    ...(typeof completed === 'number' ? { completedAt: completed } : {}),
  }
}

export function toIteration(doc: Doc): LoopIteration {
  return {
    id: text(doc._id),
    loopId: text(doc.loop_id),
    index: number(doc.idx),
    input: doc.input,
    output: doc.output,
    startedAt: number(doc.started_at),
    completedAt: number(doc.completed_at),
  }
}

export function toTaskRun(doc: Doc): TaskRunRecord {
  const model = doc.model
  if (!model || typeof model !== 'object' || Array.isArray(model)) failed()
  const pair = model as { provider?: unknown; model?: unknown }
  if (typeof pair.provider !== 'string' || typeof pair.model !== 'string') failed()
  const agentId = doc.agent_id
  const sessionId = doc.session_id
  const runId = doc.run_id
  const output = doc.output
  const usage = doc.usage
  const error = doc.error
  const duration = doc.duration_ms
  const completed = doc.completed_at
  return {
    id: text(doc._id),
    taskId: text(doc.task_id),
    ...(typeof agentId === 'string' ? { agentId } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof runId === 'string' ? { runId } : {}),
    model: { provider: pair.provider, model: pair.model },
    input: doc.input,
    ...(output != null ? { output } : {}),
    status: text(doc.status) as TaskRunStatus,
    ...(usage != null ? { usage: usage as TaskRunRecord['usage'] } : {}),
    ...(typeof error === 'string' ? { error } : {}),
    ...(typeof duration === 'number' ? { durationMs: duration } : {}),
    createdAt: number(doc.created_at),
    ...(typeof completed === 'number' ? { completedAt: completed } : {}),
  }
}

export function toCrumb(doc: Doc): CrumbLogEntry {
  const sessionId = doc.session_id
  const agentId = doc.agent_id
  return {
    runId: text(doc.run_id),
    seq: number(doc.seq),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof agentId === 'string' ? { agentId } : {}),
    type: text(doc.type),
    crumb: doc.crumb,
    createdAt: number(doc.created_at),
  }
}

export function toMemory(doc: Doc): MemoryRecord {
  return {
    id: text(doc._id),
    content: text(doc.content),
    createdAt: number(doc.created_at),
  }
}
