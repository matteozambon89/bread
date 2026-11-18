import { BreadError, decodeLastOutput, type CheckpointRecord, type CrumbLogEntry, type LoopIteration, type LoopRecord, type LoopStatus, type Session, type SessionMessage, type TaskRunRecord, type TaskRunStatus } from '@breadai/core'

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new BreadError('Store request failed.', 'STORE_REQUEST_FAILED', {})
  }
}

function num(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isFinite(parsed)) throw new BreadError('Store request failed.', 'STORE_REQUEST_FAILED', {})
  return parsed
}

export interface SessionRow {
  id: string
  created_at: unknown
  updated_at: unknown
  agent_id: string | null
  tags: unknown
  principal: unknown
}

export interface MessageRow {
  id: string
  session_id: string
  role: string
  content: unknown
  timestamp: unknown
}

export interface CheckpointRow {
  id: string
  agent_id: string
  run_id: string
  session_id: string
  execution_id: string
  tool_name: string
  tool_call_id: string
  schema: unknown
  prompt: string | null
  skill: string | null
  parent: unknown
  pending: unknown
  principal: unknown
  created_at: unknown
}

export interface LoopRow {
  id: string
  agent_id: string
  session_id: string
  run_id: string
  pool: unknown
  pipeline: unknown
  max_iterations: unknown
  status: string
  iterations: unknown
  result: unknown
  last_output: unknown
  started_at: unknown
  completed_at: unknown
}

export interface LoopIterationRow {
  id: string
  loop_id: string
  idx: unknown
  input: unknown
  output: unknown
  started_at: unknown
  completed_at: unknown
}

export interface TaskRunRow {
  id: string
  task_id: string
  agent_id: string | null
  session_id: string | null
  run_id: string | null
  model: unknown
  input: unknown
  output: unknown
  status: string
  usage: unknown
  error: string | null
  duration_ms: unknown
  created_at: unknown
  completed_at: unknown
}

export interface CrumbRow {
  run_id: string
  seq: unknown
  session_id: string | null
  agent_id: string | null
  type: string
  crumb: unknown
  created_at: unknown
}

function readLastOutput(raw: unknown): { lastOutput: unknown } | Record<string, never> {
  if (raw == null) return {}
  const decoded = decodeLastOutput(parseJson(raw))
  return decoded.present ? { lastOutput: decoded.value } : {}
}

function optionalJson<T>(value: unknown): T | undefined {
  if (value == null) return undefined
  const parsed = parseJson(value)
  if (parsed == null) return undefined
  return parsed as T
}

export function rowToSession(row: SessionRow): Session {
  const tags = parseJson(row.tags)
  const principal = optionalJson<NonNullable<Session['principal']>>(row.principal)
  return {
    id: row.id,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    tags: tags && typeof tags === 'object' && !Array.isArray(tags) ? (tags as Record<string, string>) : {},
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(principal !== undefined ? { principal } : {}),
  }
}

export function rowToMessage(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as SessionMessage['role'],
    content: parseJson(row.content),
    timestamp: num(row.timestamp),
  }
}

export function rowToCheckpoint(row: CheckpointRow): CheckpointRecord {
  const parent = optionalJson<CheckpointRecord['parent']>(row.parent)
  const pending = optionalJson<CheckpointRecord['pending']>(row.pending)
  const principal = optionalJson<CheckpointRecord['principal']>(row.principal)
  return {
    id: row.id,
    agentId: row.agent_id,
    runId: row.run_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    schema: parseJson(row.schema),
    ...(row.prompt != null ? { prompt: row.prompt } : {}),
    ...(row.skill != null ? { skill: row.skill } : {}),
    ...(parent !== undefined ? { parent } : {}),
    ...(pending !== undefined ? { pending } : {}),
    ...(principal !== undefined ? { principal } : {}),
    createdAt: num(row.created_at),
  }
}

export function rowToLoop(row: LoopRow): LoopRecord {
  const result = row.result == null ? undefined : parseJson(row.result)
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    runId: row.run_id,
    pool: (parseJson(row.pool) as string[] | null) ?? [],
    pipeline: (parseJson(row.pipeline) as string[] | null) ?? [],
    maxIterations: num(row.max_iterations),
    status: row.status as LoopStatus,
    iterations: num(row.iterations),
    ...(result !== undefined && result !== null ? { result } : {}),
    ...readLastOutput(row.last_output),
    startedAt: num(row.started_at),
    ...(row.completed_at != null ? { completedAt: num(row.completed_at) } : {}),
  }
}

export function rowToLoopIteration(row: LoopIterationRow): LoopIteration {
  return {
    id: row.id,
    loopId: row.loop_id,
    index: num(row.idx),
    input: row.input == null ? null : parseJson(row.input),
    output: row.output == null ? null : parseJson(row.output),
    startedAt: num(row.started_at),
    completedAt: num(row.completed_at),
  }
}

export function rowToTaskRun(row: TaskRunRow): TaskRunRecord {
  const output = row.output == null ? undefined : parseJson(row.output)
  const usage = row.usage == null ? undefined : parseJson(row.usage)
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.agent_id != null ? { agentId: row.agent_id } : {}),
    ...(row.session_id != null ? { sessionId: row.session_id } : {}),
    ...(row.run_id != null ? { runId: row.run_id } : {}),
    model: parseJson(row.model) as TaskRunRecord['model'],
    input: row.input == null ? null : parseJson(row.input),
    ...(output !== undefined ? { output } : {}),
    status: row.status as TaskRunStatus,
    ...(usage != null ? { usage: usage as TaskRunRecord['usage'] } : {}),
    ...(row.error != null ? { error: row.error } : {}),
    ...(row.duration_ms != null ? { durationMs: num(row.duration_ms) } : {}),
    createdAt: num(row.created_at),
    ...(row.completed_at != null ? { completedAt: num(row.completed_at) } : {}),
  }
}

export function rowToCrumb(row: CrumbRow): CrumbLogEntry {
  return {
    runId: row.run_id,
    seq: num(row.seq),
    ...(row.session_id != null ? { sessionId: row.session_id } : {}),
    ...(row.agent_id != null ? { agentId: row.agent_id } : {}),
    type: row.type,
    crumb: parseJson(row.crumb),
    createdAt: num(row.created_at),
  }
}
