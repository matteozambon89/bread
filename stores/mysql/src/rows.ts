import type { RowDataPacket } from 'mysql2/promise'
import {
  decodeLastOutput,
  type CheckpointRecord,
  type CrumbLogEntry,
  type LoopIteration,
  type LoopRecord,
  type LoopStatus,
  type Principal,
  type Session,
  type SessionMessage,
  type TaskRunRecord,
  type TaskRunStatus,
} from '@breadai/core'
import { jsonValue, num } from './values.js'

export interface SessionRow extends RowDataPacket {
  id: string
  created_at: number | string
  updated_at: number | string
  agent_id: string | null
  tags: unknown
  principal: unknown
}

export interface MessageRow extends RowDataPacket {
  id: string
  session_id: string
  role: string
  content: unknown
  timestamp: number | string
}

export interface CheckpointRow extends RowDataPacket {
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
  created_at: number | string
}

export interface LoopRow extends RowDataPacket {
  id: string
  agent_id: string
  session_id: string
  run_id: string
  pool: unknown
  pipeline: unknown
  max_iterations: number | string
  status: string
  iterations: number | string
  result: unknown
  last_output: unknown
  started_at: number | string
  completed_at: number | string | null
}

export interface LoopIterationRow extends RowDataPacket {
  id: string
  loop_id: string
  idx: number | string
  input: unknown
  output: unknown
  started_at: number | string
  completed_at: number | string
}

export interface TaskRunRow extends RowDataPacket {
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
  duration_ms: number | string | null
  created_at: number | string
  completed_at: number | string | null
}

export interface CrumbRow extends RowDataPacket {
  run_id: string
  seq: number | string
  session_id: string | null
  agent_id: string | null
  type: string
  crumb: unknown
  created_at: number | string
}

function asTags(value: unknown): Record<string, string> {
  const parsed = jsonValue(value)
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const tags: Record<string, string> = {}
  for (const key of Object.keys(parsed)) {
    const item = (parsed as Record<string, unknown>)[key]
    if (typeof item === 'string') tags[key] = item
  }
  return tags
}

function asPrincipal(value: unknown): Principal | undefined {
  const parsed = jsonValue(value)
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.iss !== 'string' || typeof record.sub !== 'string') return undefined
  const principal: Principal = { iss: record.iss, sub: record.sub }
  if (typeof record.tenant === 'string') principal.tenant = record.tenant
  if (Array.isArray(record.roles) && record.roles.every((role) => typeof role === 'string')) {
    principal.roles = record.roles
  }
  return principal
}

export function rowToSession(row: SessionRow): Session {
  const principal = asPrincipal(row.principal)
  return {
    id: row.id,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    tags: asTags(row.tags),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(principal ? { principal } : {}),
  }
}

export function rowToMessage(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as SessionMessage['role'],
    content: jsonValue(row.content),
    timestamp: num(row.timestamp),
  }
}

export function rowToCheckpoint(row: CheckpointRow): CheckpointRecord {
  const parent = jsonValue(row.parent)
  const pending = jsonValue(row.pending)
  const principal = asPrincipal(row.principal)
  return {
    id: row.id,
    agentId: row.agent_id,
    runId: row.run_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    schema: jsonValue(row.schema),
    ...(row.prompt != null ? { prompt: row.prompt } : {}),
    ...(row.skill != null ? { skill: row.skill } : {}),
    ...(parent != null ? { parent: parent as CheckpointRecord['parent'] } : {}),
    ...(pending != null ? { pending: pending as CheckpointRecord['pending'] } : {}),
    ...(principal ? { principal } : {}),
    createdAt: num(row.created_at),
  }
}

function readLastOutput(raw: unknown): { lastOutput: unknown } | Record<string, never> {
  const decoded = decodeLastOutput(jsonValue(raw))
  return decoded.present ? { lastOutput: decoded.value } : {}
}

export function rowToLoop(row: LoopRow): LoopRecord {
  const pool = jsonValue(row.pool)
  const pipeline = jsonValue(row.pipeline)
  const result = jsonValue(row.result)
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    runId: row.run_id,
    pool: Array.isArray(pool) ? (pool as string[]) : [],
    pipeline: Array.isArray(pipeline) ? (pipeline as string[]) : [],
    maxIterations: num(row.max_iterations),
    status: row.status as LoopStatus,
    iterations: num(row.iterations),
    ...(result != null ? { result } : {}),
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
    input: jsonValue(row.input),
    output: jsonValue(row.output),
    startedAt: num(row.started_at),
    completedAt: num(row.completed_at),
  }
}

export function rowToTaskRun(row: TaskRunRow): TaskRunRecord {
  const model = jsonValue(row.model) as { provider: string; model: string }
  const usage = jsonValue(row.usage) as TaskRunRecord['usage']
  const output = jsonValue(row.output)
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.agent_id != null ? { agentId: row.agent_id } : {}),
    ...(row.session_id != null ? { sessionId: row.session_id } : {}),
    ...(row.run_id != null ? { runId: row.run_id } : {}),
    model,
    input: jsonValue(row.input),
    ...(output != null ? { output } : {}),
    status: row.status as TaskRunStatus,
    ...(usage != null ? { usage } : {}),
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
    crumb: jsonValue(row.crumb),
    createdAt: num(row.created_at),
  }
}
