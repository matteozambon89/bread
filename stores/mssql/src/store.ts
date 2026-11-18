import { v7 as uuidv7 } from 'uuid'
import {
  BreadError,
  encodeLastOutput,
  requireExecutionId,
  type BreadStore,
  type CheckpointRecord,
  type CleanupOptions,
  type DocumentRecord,
  type MemoryRecord,
  type Principal,
} from '@breadai/core'
import sql, { type IResult, type Request, type Transaction } from 'mssql'
import {
  assertPrincipal,
  assertTags,
  boundLimit,
  likeContains,
  optionalClock,
  optionalText,
  requireBody,
  requireClock,
  requireId,
  requireLoopStatus,
  requireQuery,
  requireRole,
  requireTaskStatus,
} from './bind.js'
import { mssqlPool, resolveMssqlConfig, type MssqlStoreOptions } from './config.js'
import { redactDriver } from './errors.js'
import { migratePool, migrationStatus } from './migrate.js'
import {
  rowToCheckpoint,
  rowToCrumb,
  rowToLoop,
  rowToLoopIteration,
  rowToMessage,
  rowToSession,
  rowToTaskRun,
  type CheckpointRow,
  type CrumbRow,
  type LoopIterationRow,
  type LoopRow,
  type MessageRow,
  type SessionRow,
  type TaskRunRow,
} from './rows.js'

const SEARCH_MAX = 100
const LIST_MAX = 1000
const BODY_MAX = 1_000_000

const UPSERT_CHECKPOINT = `MERGE dbo.bread_checkpoints WITH (HOLDLOCK) AS target
USING (SELECT @id AS id) AS source
ON target.id COLLATE Latin1_General_BIN2 = source.id COLLATE Latin1_General_BIN2
WHEN MATCHED THEN UPDATE SET
  agent_id = @agentId,
  run_id = @runId,
  session_id = @sessionId,
  execution_id = @executionId,
  tool_name = @toolName,
  tool_call_id = @toolCallId,
  [schema] = @schemaJson,
  prompt = @prompt,
  skill = @skill,
  parent = @parentJson,
  pending = @pendingJson,
  principal = @principalJson,
  created_at = @createdAt
WHEN NOT MATCHED THEN INSERT (
  id, agent_id, run_id, session_id, execution_id, tool_name, tool_call_id,
  [schema], prompt, skill, parent, pending, principal, created_at
) VALUES (
  @id, @agentId, @runId, @sessionId, @executionId, @toolName, @toolCallId,
  @schemaJson, @prompt, @skill, @parentJson, @pendingJson, @principalJson, @createdAt
);`

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value === undefined ? null : value)
  } catch {
    throw new BreadError('Store request failed.', 'STORE_REQUEST_FAILED', {})
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined) return null
  return jsonText(value)
}

function int64(request: Request, name: string, value: number | null): void {
  request.input(name, sql.BigInt, value === null ? null : String(Math.trunc(value)))
}

function requireCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BreadError('Limit is invalid.', 'INVALID_INPUT', {})
  }
  return value
}

function requireStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 450)) {
    throw new BreadError('Id is invalid.', 'INVALID_INPUT', {})
  }
  return value as string[]
}

function clock(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isFinite(parsed)) throw new BreadError('Store request failed.', 'STORE_REQUEST_FAILED', {})
  return parsed
}

function rows<T>(result: IResult<T>): T[] {
  return result.recordset ? [...result.recordset] : []
}

// OUTPUT is the deleted row. rowsAffected also counts ON DELETE CASCADE rows.
function outputCount<T>(result: IResult<T>): number {
  return result.recordset?.length ?? 0
}

function bindCheckpoint(request: Request, record: CheckpointRecord): void {
  const executionId = requireExecutionId(record.executionId, 'saveCheckpoint')
  request.input('id', sql.NVarChar(450), requireId(record.id))
  request.input('agentId', sql.NVarChar(450), requireId(record.agentId))
  request.input('runId', sql.NVarChar(450), requireId(record.runId))
  request.input('sessionId', sql.NVarChar(450), requireId(record.sessionId))
  request.input('executionId', sql.NVarChar(450), executionId)
  request.input('toolName', sql.NVarChar(256), requireId(record.toolName, 256))
  request.input('toolCallId', sql.NVarChar(450), requireId(record.toolCallId))
  request.input('schemaJson', sql.NVarChar(sql.MAX), jsonText(record.schema ?? null))
  request.input('prompt', sql.NVarChar(sql.MAX), optionalText(record.prompt, BODY_MAX))
  request.input('skill', sql.NVarChar(256), optionalText(record.skill, 256))
  request.input('parentJson', sql.NVarChar(sql.MAX), jsonOrNull(record.parent))
  request.input('pendingJson', sql.NVarChar(sql.MAX), jsonOrNull(record.pending))
  request.input('principalJson', sql.NVarChar(sql.MAX), record.principal === undefined ? null : jsonText(checkedPrincipal(record.principal)))
  int64(request, 'createdAt', requireClock(record.createdAt))
}

function checkedPrincipal(principal: Principal): Principal {
  assertPrincipal(principal)
  return principal
}

function bindOwner(request: Request, agentId: string, principal: Principal): { iss: string; sub: string } {
  const scope = assertPrincipal(principal)
  request.input('agentId', sql.NVarChar(256), requireId(agentId, 256))
  request.input('iss', sql.NVarChar(256), scope.iss)
  request.input('sub', sql.NVarChar(256), scope.sub)
  return scope
}

export function store(opts: MssqlStoreOptions = {}): BreadStore {
  const pool = mssqlPool(resolveMssqlConfig(opts))
  let opening: Promise<void> | undefined

  async function ready(): Promise<void> {
    if (pool.connected) return
    if (!opening) {
      opening = pool.connect().then(
        () => undefined,
        (err: unknown) => {
          opening = undefined
          throw new BreadError('Could not connect to SQL Server.', 'STORE_CONNECT', {}, redactDriver(err))
        },
      )
    }
    await opening
  }

  async function query<T>(text: string, bind?: (request: Request) => void, tx?: Transaction): Promise<IResult<T>> {
    try {
      if (!tx) await ready()
      const request = tx ? tx.request() : pool.request()
      bind?.(request)
      return await request.query<T>(text)
    } catch (err) {
      if (err instanceof BreadError) throw err
      throw new BreadError('Store request failed.', 'STORE_REQUEST_FAILED', {}, redactDriver(err))
    }
  }

  async function withTx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    await ready()
    const tx = new sql.Transaction(pool)
    try {
      await tx.begin()
    } catch (err) {
      if (err instanceof BreadError) throw err
      throw new BreadError('Store request failed.', 'STORE_REQUEST_FAILED', {}, redactDriver(err))
    }
    try {
      const result = await fn(tx)
      await tx.commit()
      return result
    } catch (err) {
      try {
        await tx.rollback()
      } catch {
        // The original error is the one callers need.
      }
      throw err
    }
  }

  const breadStore: BreadStore = {
    async createSession(options) {
      const id = options?.id === undefined ? uuidv7() : requireId(options.id)
      const tags = assertTags(options?.tags)
      const principal = options?.principal === undefined ? undefined : checkedPrincipal(options.principal)
      const now = Date.now()
      await query(
        `INSERT INTO dbo.bread_sessions (id, created_at, updated_at, tags, principal)
         VALUES (@id, @createdAt, @updatedAt, @tags, @principal)`,
        (request) => {
          request.input('id', sql.NVarChar(450), id)
          int64(request, 'createdAt', now)
          int64(request, 'updatedAt', now)
          request.input('tags', sql.NVarChar(sql.MAX), JSON.stringify(tags))
          request.input('principal', sql.NVarChar(sql.MAX), principal === undefined ? null : jsonText(principal))
        },
      )
      return { id, createdAt: now, updatedAt: now, tags, ...(principal ? { principal } : {}) }
    },

    async claimSessionPrincipal(id, principal) {
      checkedPrincipal(principal)
      const result = await query<{ id: string }>(
        `UPDATE dbo.bread_sessions
         SET principal = @principal
         OUTPUT INSERTED.id
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2
           AND principal IS NULL`,
        (request) => {
          request.input('id', sql.NVarChar(450), requireId(id))
          request.input('principal', sql.NVarChar(sql.MAX), jsonText(principal))
        },
      )
      return outputCount(result) === 1
    },

    async getSession(id) {
      const result = await query<SessionRow>(
        `SELECT id, created_at, updated_at, agent_id, tags, principal
         FROM dbo.bread_sessions
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
        (request) => request.input('id', sql.NVarChar(450), requireId(id)),
      )
      const row = rows(result)[0]
      return row ? rowToSession(row) : undefined
    },

    async listSessions(filter) {
      const tags = assertTags(filter?.tags)
      const result = await query<SessionRow>(
        `SELECT id, created_at, updated_at, agent_id, tags, principal
         FROM dbo.bread_sessions
         WHERE NOT EXISTS (
           SELECT 1 FROM OPENJSON(@tags) AS wanted
           WHERE NOT EXISTS (
             SELECT 1 FROM OPENJSON(tags) AS have
             WHERE have.[key] COLLATE Latin1_General_BIN2 = wanted.[key] COLLATE Latin1_General_BIN2
               AND have.[value] COLLATE Latin1_General_BIN2 = wanted.[value] COLLATE Latin1_General_BIN2
           )
         )`,
        (request) => request.input('tags', sql.NVarChar(sql.MAX), JSON.stringify(tags)),
      )
      return rows(result).map(rowToSession)
    },

    async deleteSession(id) {
      await query(
        `DELETE FROM dbo.bread_sessions
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
        (request) => request.input('id', sql.NVarChar(450), requireId(id)),
      )
    },

    async deleteSessionForPrincipal(id, principal) {
      const scope = assertPrincipal(principal)
      const result = await query<{ id: string }>(
        `DELETE FROM dbo.bread_sessions
         OUTPUT DELETED.id
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2
           AND principal IS NOT NULL
           AND JSON_VALUE(principal, N'$.iss') COLLATE Latin1_General_BIN2 = @iss COLLATE Latin1_General_BIN2
           AND JSON_VALUE(principal, N'$.sub') COLLATE Latin1_General_BIN2 = @sub COLLATE Latin1_General_BIN2`,
        (request) => {
          request.input('id', sql.NVarChar(450), requireId(id))
          request.input('iss', sql.NVarChar(256), scope.iss)
          request.input('sub', sql.NVarChar(256), scope.sub)
        },
      )
      return outputCount(result) === 1
    },

    async cleanupSessions(opts?: CleanupOptions) {
      if (opts?.olderThanMs === undefined) return 0
      if (typeof opts.olderThanMs !== 'number' || !Number.isFinite(opts.olderThanMs) || opts.olderThanMs < 0) {
        throw new BreadError('Limit is invalid.', 'INVALID_INPUT', {})
      }
      const tags = assertTags(opts.tags)
      const scope = opts.principal === undefined ? undefined : assertPrincipal(opts.principal)
      const olderThanMs = opts.olderThanMs
      const result = await query<{ id: string }>(
        `DELETE FROM dbo.bread_sessions
         OUTPUT DELETED.id
         WHERE updated_at < @cutoff
           AND (
             @scoped = 0
             OR (
               principal IS NOT NULL
               AND JSON_VALUE(principal, N'$.iss') COLLATE Latin1_General_BIN2 = @iss COLLATE Latin1_General_BIN2
               AND JSON_VALUE(principal, N'$.sub') COLLATE Latin1_General_BIN2 = @sub COLLATE Latin1_General_BIN2
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM OPENJSON(@tags) AS wanted
             WHERE NOT EXISTS (
               SELECT 1 FROM OPENJSON(tags) AS have
               WHERE have.[key] COLLATE Latin1_General_BIN2 = wanted.[key] COLLATE Latin1_General_BIN2
                 AND have.[value] COLLATE Latin1_General_BIN2 = wanted.[value] COLLATE Latin1_General_BIN2
             )
           )`,
        (request) => {
          int64(request, 'cutoff', Date.now() - olderThanMs)
          request.input('scoped', sql.Int, scope ? 1 : 0)
          request.input('iss', sql.NVarChar(256), scope?.iss ?? '')
          request.input('sub', sql.NVarChar(256), scope?.sub ?? '')
          request.input('tags', sql.NVarChar(sql.MAX), JSON.stringify(tags))
        },
      )
      return outputCount(result)
    },

    async getMessages(sessionId) {
      const result = await query<MessageRow>(
        `SELECT id, session_id, [role], content, [timestamp]
         FROM dbo.bread_session_messages
         WHERE session_id COLLATE Latin1_General_BIN2 = @sessionId COLLATE Latin1_General_BIN2
         ORDER BY [timestamp] ASC, id ASC`,
        (request) => request.input('sessionId', sql.NVarChar(450), requireId(sessionId)),
      )
      return rows(result).map(rowToMessage)
    },

    async addMessage(sessionId, message) {
      const id = requireId(sessionId)
      const role = requireRole(message.role)
      const timestamp = message.timestamp === undefined ? Date.now() : requireClock(message.timestamp)
      const content = jsonText(message.content)
      await withTx(async (tx) => {
        await query(
          `INSERT INTO dbo.bread_session_messages (id, session_id, [role], content, [timestamp])
           VALUES (@id, @sessionId, @role, @content, @timestamp)`,
          (request) => {
            request.input('id', sql.NVarChar(450), uuidv7())
            request.input('sessionId', sql.NVarChar(450), id)
            request.input('role', sql.NVarChar(32), role)
            request.input('content', sql.NVarChar(sql.MAX), content)
            int64(request, 'timestamp', timestamp)
          },
          tx,
        )
        await query(
          `UPDATE dbo.bread_sessions
           SET updated_at = @updatedAt
           WHERE id COLLATE Latin1_General_BIN2 = @sessionId COLLATE Latin1_General_BIN2`,
          (request) => {
            int64(request, 'updatedAt', timestamp)
            request.input('sessionId', sql.NVarChar(450), id)
          },
          tx,
        )
      })
    },

    async saveCheckpoint(record) {
      requireExecutionId(record.executionId, 'saveCheckpoint')
      await query(UPSERT_CHECKPOINT, (request) => bindCheckpoint(request, record))
    },

    async getCheckpoint(id) {
      const result = await query<CheckpointRow>(
        `SELECT * FROM dbo.bread_checkpoints
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
        (request) => request.input('id', sql.NVarChar(450), requireId(id)),
      )
      const row = rows(result)[0]
      return row ? rowToCheckpoint(row) : undefined
    },

    async claimCheckpoint(id) {
      const result = await query<CheckpointRow>(
        `UPDATE dbo.bread_checkpoints
         SET claimed = 1
         OUTPUT INSERTED.*
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2
           AND claimed = 0`,
        (request) => request.input('id', sql.NVarChar(450), requireId(id)),
      )
      const row = rows(result)[0]
      return row ? rowToCheckpoint(row) : undefined
    },

    async deleteCheckpoint(id, options) {
      const result = await query<CheckpointRow>(
        `DELETE FROM dbo.bread_checkpoints
         OUTPUT DELETED.*
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2
           AND (@unclaimed = 0 OR claimed = 0)`,
        (request) => {
          request.input('id', sql.NVarChar(450), requireId(id))
          request.input('unclaimed', sql.Int, options?.unclaimedOnly ? 1 : 0)
        },
      )
      const row = rows(result)[0]
      return row ? rowToCheckpoint(row) : undefined
    },

    async listCheckpoints(filter) {
      const executionId = filter && requireExecutionId(filter.executionId, 'listCheckpoints')
      const result =
        executionId === undefined
          ? await query<CheckpointRow>(`SELECT * FROM dbo.bread_checkpoints ORDER BY created_at ASC`)
          : await query<CheckpointRow>(
              `SELECT * FROM dbo.bread_checkpoints
               WHERE execution_id COLLATE Latin1_General_BIN2 = @executionId COLLATE Latin1_General_BIN2
               ORDER BY created_at ASC`,
              (request) => request.input('executionId', sql.NVarChar(450), executionId),
            )
      return rows(result).map(rowToCheckpoint)
    },

    async suspendRun(sessionId, messages, checkpoint) {
      requireExecutionId(checkpoint.executionId, 'suspendRun')
      const id = requireId(sessionId)
      await withTx(async (tx) => {
        let last = requireClock(checkpoint.createdAt)
        for (const message of messages) {
          const timestamp = message.timestamp === undefined ? Date.now() : requireClock(message.timestamp)
          await query(
            `INSERT INTO dbo.bread_session_messages (id, session_id, [role], content, [timestamp])
             VALUES (@id, @sessionId, @role, @content, @timestamp)`,
            (request) => {
              request.input('id', sql.NVarChar(450), uuidv7())
              request.input('sessionId', sql.NVarChar(450), id)
              request.input('role', sql.NVarChar(32), requireRole(message.role))
              request.input('content', sql.NVarChar(sql.MAX), jsonText(message.content))
              int64(request, 'timestamp', timestamp)
            },
            tx,
          )
          last = timestamp
        }
        await query(
          `UPDATE dbo.bread_sessions SET updated_at = @updatedAt
           WHERE id COLLATE Latin1_General_BIN2 = @sessionId COLLATE Latin1_General_BIN2`,
          (request) => {
            int64(request, 'updatedAt', last)
            request.input('sessionId', sql.NVarChar(450), id)
          },
          tx,
        )
        await query(UPSERT_CHECKPOINT, (request) => bindCheckpoint(request, checkpoint), tx)
      })
    },

    async createLoop(record) {
      await query(
        `INSERT INTO dbo.bread_loops
           (id, agent_id, session_id, run_id, pool, pipeline, max_iterations, status, iterations, result, started_at, completed_at)
         VALUES
           (@id, @agentId, @sessionId, @runId, @pool, @pipeline, @maxIterations, @status, @iterations, @result, @startedAt, @completedAt)`,
        (request) => {
          request.input('id', sql.NVarChar(450), requireId(record.id))
          request.input('agentId', sql.NVarChar(450), requireId(record.agentId))
          request.input('sessionId', sql.NVarChar(450), requireId(record.sessionId))
          request.input('runId', sql.NVarChar(450), requireId(record.runId))
          request.input('pool', sql.NVarChar(sql.MAX), jsonText(requireStringList(record.pool)))
          request.input('pipeline', sql.NVarChar(sql.MAX), jsonText(requireStringList(record.pipeline)))
          request.input('maxIterations', sql.Int, requireCount(record.maxIterations))
          request.input('status', sql.NVarChar(64), requireLoopStatus(record.status))
          request.input('iterations', sql.Int, requireCount(record.iterations))
          request.input('result', sql.NVarChar(sql.MAX), jsonOrNull(record.result))
          int64(request, 'startedAt', requireClock(record.startedAt))
          int64(request, 'completedAt', optionalClock(record.completedAt))
        },
      )
    },

    async updateLoop(id, patch) {
      const loopId = requireId(id)
      if (patch.status !== undefined) {
        await query(
          `UPDATE dbo.bread_loops SET status = @status
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            request.input('status', sql.NVarChar(64), requireLoopStatus(patch.status))
            request.input('id', sql.NVarChar(450), loopId)
          },
        )
      }
      if (patch.iterations !== undefined) {
        await query(
          `UPDATE dbo.bread_loops SET iterations = @iterations
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            request.input('iterations', sql.Int, requireCount(patch.iterations))
            request.input('id', sql.NVarChar(450), loopId)
          },
        )
      }
      if (patch.result !== undefined) {
        await query(
          `UPDATE dbo.bread_loops SET result = @result
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            request.input('result', sql.NVarChar(sql.MAX), jsonText(patch.result))
            request.input('id', sql.NVarChar(450), loopId)
          },
        )
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'lastOutput')) {
        await query(
          `UPDATE dbo.bread_loops SET last_output = @lastOutput
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            request.input('lastOutput', sql.NVarChar(sql.MAX), jsonText(encodeLastOutput(patch.lastOutput)))
            request.input('id', sql.NVarChar(450), loopId)
          },
        )
      }
      if (patch.completedAt !== undefined) {
        await query(
          `UPDATE dbo.bread_loops SET completed_at = @completedAt
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            int64(request, 'completedAt', requireClock(patch.completedAt))
            request.input('id', sql.NVarChar(450), loopId)
          },
        )
      }
    },

    async addLoopIteration(iteration) {
      await query(
        `INSERT INTO dbo.bread_loop_iterations (id, loop_id, idx, input, output, started_at, completed_at)
         VALUES (@id, @loopId, @idx, @input, @output, @startedAt, @completedAt)`,
        (request) => {
          request.input('id', sql.NVarChar(450), requireId(iteration.id))
          request.input('loopId', sql.NVarChar(450), requireId(iteration.loopId))
          request.input('idx', sql.Int, requireCount(iteration.index))
          request.input('input', sql.NVarChar(sql.MAX), jsonOrNull(iteration.input))
          request.input('output', sql.NVarChar(sql.MAX), jsonOrNull(iteration.output))
          int64(request, 'startedAt', requireClock(iteration.startedAt))
          int64(request, 'completedAt', requireClock(iteration.completedAt))
        },
      )
    },

    async getLoop(id) {
      const loopId = requireId(id)
      const result = await query<LoopRow>(
        `SELECT * FROM dbo.bread_loops
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
        (request) => request.input('id', sql.NVarChar(450), loopId),
      )
      const row = rows(result)[0]
      if (!row) return undefined
      const iterations = await query<LoopIterationRow>(
        `SELECT * FROM dbo.bread_loop_iterations
         WHERE loop_id COLLATE Latin1_General_BIN2 = @loopId COLLATE Latin1_General_BIN2
         ORDER BY idx ASC`,
        (request) => request.input('loopId', sql.NVarChar(450), loopId),
      )
      return { loop: rowToLoop(row), iterations: rows(iterations).map(rowToLoopIteration) }
    },

    async listLoops(filter) {
      const parts: string[] = []
      const sessionId = filter?.sessionId === undefined ? undefined : requireId(filter.sessionId)
      const agentId = filter?.agentId === undefined ? undefined : requireId(filter.agentId)
      const status = filter?.status === undefined ? undefined : requireLoopStatus(filter.status)
      if (sessionId !== undefined) {
        parts.push('session_id COLLATE Latin1_General_BIN2 = @sessionId COLLATE Latin1_General_BIN2')
      }
      if (agentId !== undefined) {
        parts.push('agent_id COLLATE Latin1_General_BIN2 = @agentId COLLATE Latin1_General_BIN2')
      }
      if (status !== undefined) {
        parts.push('status COLLATE Latin1_General_BIN2 = @status COLLATE Latin1_General_BIN2')
      }
      const where = parts.length === 0 ? '' : `WHERE ${parts.join(' AND ')}`
      const result = await query<LoopRow>(
        `SELECT * FROM dbo.bread_loops ${where} ORDER BY started_at DESC`,
        (request) => {
          if (sessionId !== undefined) request.input('sessionId', sql.NVarChar(450), sessionId)
          if (agentId !== undefined) request.input('agentId', sql.NVarChar(450), agentId)
          if (status !== undefined) request.input('status', sql.NVarChar(64), status)
        },
      )
      return rows(result).map(rowToLoop)
    },

    async createTaskRun(record) {
      await query(
        `INSERT INTO dbo.bread_task_runs
           (id, task_id, agent_id, session_id, run_id, model, input, output, status, usage, error, duration_ms, created_at, completed_at)
         VALUES
           (@id, @taskId, @agentId, @sessionId, @runId, @model, @input, @output, @status, @usage, @error, @durationMs, @createdAt, @completedAt)`,
        (request) => {
          request.input('id', sql.NVarChar(450), requireId(record.id))
          request.input('taskId', sql.NVarChar(450), requireId(record.taskId))
          request.input('agentId', sql.NVarChar(450), record.agentId === undefined ? null : requireId(record.agentId))
          request.input('sessionId', sql.NVarChar(450), record.sessionId === undefined ? null : requireId(record.sessionId))
          request.input('runId', sql.NVarChar(450), record.runId === undefined ? null : requireId(record.runId))
          request.input('model', sql.NVarChar(sql.MAX), jsonText(record.model))
          request.input('input', sql.NVarChar(sql.MAX), jsonOrNull(record.input))
          request.input('output', sql.NVarChar(sql.MAX), jsonOrNull(record.output))
          request.input('status', sql.NVarChar(64), requireTaskStatus(record.status))
          request.input('usage', sql.NVarChar(sql.MAX), jsonOrNull(record.usage))
          request.input('error', sql.NVarChar(sql.MAX), optionalText(record.error, BODY_MAX))
          request.input('durationMs', sql.Int, record.durationMs === undefined ? null : requireCount(record.durationMs))
          int64(request, 'createdAt', requireClock(record.createdAt))
          int64(request, 'completedAt', optionalClock(record.completedAt))
        },
      )
    },

    async finishTaskRun(id, patch) {
      const taskId = requireId(id)
      if (patch.status !== undefined) {
        await query(
          `UPDATE dbo.bread_task_runs SET status = @status
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            request.input('status', sql.NVarChar(64), requireTaskStatus(patch.status))
            request.input('id', sql.NVarChar(450), taskId)
          },
        )
      }
      if (patch.output !== undefined) {
        await query(
          `UPDATE dbo.bread_task_runs SET output = @output
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            request.input('output', sql.NVarChar(sql.MAX), jsonText(patch.output))
            request.input('id', sql.NVarChar(450), taskId)
          },
        )
      }
      if (patch.usage !== undefined) {
        await query(
          `UPDATE dbo.bread_task_runs SET usage = @usage
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            request.input('usage', sql.NVarChar(sql.MAX), jsonText(patch.usage))
            request.input('id', sql.NVarChar(450), taskId)
          },
        )
      }
      if (patch.error !== undefined) {
        await query(
          `UPDATE dbo.bread_task_runs SET error = @error
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            request.input('error', sql.NVarChar(sql.MAX), optionalText(patch.error, BODY_MAX))
            request.input('id', sql.NVarChar(450), taskId)
          },
        )
      }
      if (patch.durationMs !== undefined) {
        await query(
          `UPDATE dbo.bread_task_runs SET duration_ms = @durationMs
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            request.input('durationMs', sql.Int, requireCount(patch.durationMs))
            request.input('id', sql.NVarChar(450), taskId)
          },
        )
      }
      if (patch.completedAt !== undefined) {
        await query(
          `UPDATE dbo.bread_task_runs SET completed_at = @completedAt
           WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
          (request) => {
            int64(request, 'completedAt', requireClock(patch.completedAt))
            request.input('id', sql.NVarChar(450), taskId)
          },
        )
      }
    },

    async getTaskRun(id) {
      const result = await query<TaskRunRow>(
        `SELECT * FROM dbo.bread_task_runs
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2`,
        (request) => request.input('id', sql.NVarChar(450), requireId(id)),
      )
      const row = rows(result)[0]
      return row ? rowToTaskRun(row) : undefined
    },

    async listTaskRuns(filter) {
      const parts: string[] = []
      const taskId = filter?.taskId === undefined ? undefined : requireId(filter.taskId)
      const agentId = filter?.agentId === undefined ? undefined : requireId(filter.agentId)
      const sessionId = filter?.sessionId === undefined ? undefined : requireId(filter.sessionId)
      const status = filter?.status === undefined ? undefined : requireTaskStatus(filter.status)
      const limit = filter?.limit === undefined ? undefined : boundLimit(filter.limit, 1, LIST_MAX)
      if (taskId !== undefined) parts.push('task_id COLLATE Latin1_General_BIN2 = @taskId COLLATE Latin1_General_BIN2')
      if (agentId !== undefined) parts.push('agent_id COLLATE Latin1_General_BIN2 = @agentId COLLATE Latin1_General_BIN2')
      if (sessionId !== undefined) {
        parts.push('session_id COLLATE Latin1_General_BIN2 = @sessionId COLLATE Latin1_General_BIN2')
      }
      if (status !== undefined) parts.push('status COLLATE Latin1_General_BIN2 = @status COLLATE Latin1_General_BIN2')
      const where = parts.length === 0 ? '' : `WHERE ${parts.join(' AND ')}`
      const fetch = limit === undefined ? '' : 'OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY'
      const result = await query<TaskRunRow>(
        `SELECT * FROM dbo.bread_task_runs ${where} ORDER BY created_at DESC ${fetch}`,
        (request) => {
          if (taskId !== undefined) request.input('taskId', sql.NVarChar(450), taskId)
          if (agentId !== undefined) request.input('agentId', sql.NVarChar(450), agentId)
          if (sessionId !== undefined) request.input('sessionId', sql.NVarChar(450), sessionId)
          if (status !== undefined) request.input('status', sql.NVarChar(64), status)
          if (limit !== undefined) request.input('limit', sql.Int, limit)
        },
      )
      return rows(result).map(rowToTaskRun)
    },

    async appendCrumbs(entries) {
      if (entries.length === 0) return
      const prepared = entries.map((entry) => ({
        runId: requireId(entry.runId),
        seq: requireCount(entry.seq),
        sessionId: entry.sessionId == null ? null : requireId(entry.sessionId),
        agentId: entry.agentId == null ? null : requireId(entry.agentId),
        type: requireId(entry.type, 256),
        crumb: jsonText(entry.crumb),
        createdAt: requireClock(entry.createdAt),
      }))
      await withTx(async (tx) => {
        for (const entry of prepared) {
          await query(
            `INSERT INTO dbo.bread_crumbs (run_id, seq, session_id, agent_id, [type], crumb, created_at)
             VALUES (@runId, @seq, @sessionId, @agentId, @type, @crumb, @createdAt)`,
            (request) => {
              request.input('runId', sql.NVarChar(450), entry.runId)
              int64(request, 'seq', entry.seq)
              request.input('sessionId', sql.NVarChar(450), entry.sessionId)
              request.input('agentId', sql.NVarChar(450), entry.agentId)
              request.input('type', sql.NVarChar(256), entry.type)
              request.input('crumb', sql.NVarChar(sql.MAX), entry.crumb)
              int64(request, 'createdAt', entry.createdAt)
            },
            tx,
          )
        }
      })
    },

    async getCrumbs(runId, opts) {
      const id = requireId(runId)
      const after = opts?.afterSeq === undefined ? 0 : requireCount(opts.afterSeq)
      const limit = opts?.limit === undefined ? undefined : boundLimit(opts.limit, 1, LIST_MAX)
      const fetch = limit === undefined ? '' : 'OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY'
      const result = await query<CrumbRow>(
        `SELECT run_id, seq, session_id, agent_id, [type], crumb, created_at
         FROM dbo.bread_crumbs
         WHERE run_id COLLATE Latin1_General_BIN2 = @runId COLLATE Latin1_General_BIN2
           AND seq > @after
         ORDER BY seq ASC
         ${fetch}`,
        (request) => {
          request.input('runId', sql.NVarChar(450), id)
          int64(request, 'after', after)
          if (limit !== undefined) request.input('limit', sql.Int, limit)
        },
      )
      return rows(result).map(rowToCrumb)
    },

    async getMaxCrumbSeq(runId) {
      const result = await query<{ max_seq: unknown }>(
        `SELECT MAX(seq) AS max_seq FROM dbo.bread_crumbs
         WHERE run_id COLLATE Latin1_General_BIN2 = @runId COLLATE Latin1_General_BIN2`,
        (request) => request.input('runId', sql.NVarChar(450), requireId(runId)),
      )
      const value = rows(result)[0]?.max_seq
      return value == null ? 0 : clock(value)
    },

    async addMemory({ agentId, principal, content }) {
      const id = uuidv7()
      const now = Date.now()
      const body = requireBody(content, BODY_MAX)
      await query(
        `INSERT INTO dbo.bread_memories (id, agent_id, principal_iss, principal_sub, content, created_at)
         VALUES (@id, @agentId, @iss, @sub, @content, @createdAt)`,
        (request) => {
          request.input('id', sql.NVarChar(450), id)
          bindOwner(request, agentId, principal)
          request.input('content', sql.NVarChar(sql.MAX), body)
          int64(request, 'createdAt', now)
        },
      )
      return { id, content: body, createdAt: now }
    },

    async searchMemories({ agentId, principal, query: text, limit }) {
      const pattern = likeContains(requireQuery(text))
      const take = boundLimit(limit, 10, SEARCH_MAX)
      const result = await query<{ id: string; content: string; created_at: unknown }>(
        `SELECT id, content, created_at FROM dbo.bread_memories
         WHERE agent_id COLLATE Latin1_General_BIN2 = @agentId COLLATE Latin1_General_BIN2
           AND principal_iss COLLATE Latin1_General_BIN2 = @iss COLLATE Latin1_General_BIN2
           AND principal_sub COLLATE Latin1_General_BIN2 = @sub COLLATE Latin1_General_BIN2
           AND content LIKE @pattern ESCAPE '\\'
         ORDER BY created_at DESC
         OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`,
        (request) => {
          bindOwner(request, agentId, principal)
          request.input('pattern', sql.NVarChar(sql.MAX), pattern)
          request.input('limit', sql.Int, take)
        },
      )
      return rows(result).map((row): MemoryRecord => ({ id: row.id, content: row.content, createdAt: clock(row.created_at) }))
    },

    async listMemories({ agentId, principal, limit }) {
      const take = boundLimit(limit, 100, SEARCH_MAX)
      const result = await query<{ id: string; content: string; created_at: unknown }>(
        `SELECT id, content, created_at FROM dbo.bread_memories
         WHERE agent_id COLLATE Latin1_General_BIN2 = @agentId COLLATE Latin1_General_BIN2
           AND principal_iss COLLATE Latin1_General_BIN2 = @iss COLLATE Latin1_General_BIN2
           AND principal_sub COLLATE Latin1_General_BIN2 = @sub COLLATE Latin1_General_BIN2
         ORDER BY created_at DESC
         OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`,
        (request) => {
          bindOwner(request, agentId, principal)
          request.input('limit', sql.Int, take)
        },
      )
      return rows(result).map((row): MemoryRecord => ({ id: row.id, content: row.content, createdAt: clock(row.created_at) }))
    },

    async forgetMemory({ agentId, principal, id }) {
      const result = await query<{ id: string }>(
        `DELETE FROM dbo.bread_memories
         OUTPUT DELETED.id
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2
           AND agent_id COLLATE Latin1_General_BIN2 = @agentId COLLATE Latin1_General_BIN2
           AND principal_iss COLLATE Latin1_General_BIN2 = @iss COLLATE Latin1_General_BIN2
           AND principal_sub COLLATE Latin1_General_BIN2 = @sub COLLATE Latin1_General_BIN2`,
        (request) => {
          request.input('id', sql.NVarChar(450), requireId(id))
          bindOwner(request, agentId, principal)
        },
      )
      return { deleted: outputCount(result) === 1 }
    },

    async ingestDocument({ agentId, title, content, source }) {
      const id = uuidv7()
      const now = Date.now()
      const storedTitle = requireBody(title, BODY_MAX)
      await query(
        `INSERT INTO dbo.bread_documents (id, agent_id, title, content, source, created_at)
         VALUES (@id, @agentId, @title, @content, @source, @createdAt)`,
        (request) => {
          request.input('id', sql.NVarChar(450), id)
          request.input('agentId', sql.NVarChar(450), requireId(agentId))
          request.input('title', sql.NVarChar(sql.MAX), storedTitle)
          request.input('content', sql.NVarChar(sql.MAX), requireBody(content, BODY_MAX))
          request.input('source', sql.NVarChar(sql.MAX), optionalText(source, BODY_MAX))
          int64(request, 'createdAt', now)
        },
      )
      return { id, title: storedTitle }
    },

    async searchDocuments({ agentId, query: text, limit }) {
      const pattern = likeContains(requireQuery(text))
      const take = boundLimit(limit, 5, SEARCH_MAX)
      const result = await query<{ id: string; title: string; source: string | null }>(
        `SELECT id, title, source FROM dbo.bread_documents
         WHERE agent_id COLLATE Latin1_General_BIN2 = @agentId COLLATE Latin1_General_BIN2
           AND (title LIKE @pattern ESCAPE '\\' OR content LIKE @pattern ESCAPE '\\')
         ORDER BY created_at DESC
         OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`,
        (request) => {
          request.input('agentId', sql.NVarChar(450), requireId(agentId))
          request.input('pattern', sql.NVarChar(sql.MAX), pattern)
          request.input('limit', sql.Int, take)
        },
      )
      return rows(result).map((row): DocumentRecord => ({ id: row.id, title: row.title, source: row.source }))
    },

    async readDocument({ agentId, id }) {
      const result = await query<{ title: string; content: string }>(
        `SELECT title, content FROM dbo.bread_documents
         WHERE id COLLATE Latin1_General_BIN2 = @id COLLATE Latin1_General_BIN2
           AND agent_id COLLATE Latin1_General_BIN2 = @agentId COLLATE Latin1_General_BIN2`,
        (request) => {
          request.input('id', sql.NVarChar(450), requireId(id))
          request.input('agentId', sql.NVarChar(450), requireId(agentId))
        },
      )
      const row = rows(result)[0]
      return row ? { title: row.title, content: row.content } : undefined
    },

    async migrate() {
      await ready()
      return migratePool(pool)
    },

    async migrations() {
      await ready()
      return migrationStatus(pool)
    },

    async close() {
      opening = undefined
      if (pool.connected || pool.connecting) await pool.close()
    },
  }
  return breadStore
}

export type { MssqlStoreOptions }
