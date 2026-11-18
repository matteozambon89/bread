import type { RowDataPacket } from 'mysql2/promise'
import { v7 as uuidv7 } from 'uuid'
import {
  BreadError,
  encodeLastOutput,
  readMigrationStatus,
  requireExecutionId,
  runMigrations,
  type BreadStore,
  type CheckpointRecord,
  type CleanupOptions,
  type DocumentRecord,
  type LoopFilter,
  type MemoryRecord,
  type Principal,
  type SessionMessage,
  type TaskRunFilter,
} from '@breadai/core'
import { mysqlPool, type MysqlStoreOptions } from './connect.js'
import { executeSql, rethrow, selectRows, withTransaction, type Sql, type SqlValue } from './db.js'
import { mysqlMigration } from './migrate.js'
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
import {
  asString,
  jsonText,
  likeContains,
  LIMIT_MAX,
  limitParam,
  principalJson,
  principalKeys,
  tagsJson,
} from './values.js'

export type { MysqlStoreOptions } from './connect.js'

const LIKE = "LIKE ? ESCAPE '\\\\'"

const UPSERT_CHECKPOINT = `INSERT INTO bread_checkpoints
  (id, agent_id, run_id, session_id, execution_id, tool_name, tool_call_id, \`schema\`, prompt, skill, parent, pending, principal, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?) AS incoming
  ON DUPLICATE KEY UPDATE
    agent_id = incoming.agent_id,
    run_id = incoming.run_id,
    session_id = incoming.session_id,
    execution_id = incoming.execution_id,
    tool_name = incoming.tool_name,
    tool_call_id = incoming.tool_call_id,
    \`schema\` = incoming.\`schema\`,
    prompt = incoming.prompt,
    skill = incoming.skill,
    parent = incoming.parent,
    pending = incoming.pending,
    principal = incoming.principal,
    created_at = incoming.created_at`

function attempt<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch(rethrow)
}

function where(clauses: string[]): string {
  return clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
}

function textOrNull(value: string | undefined): string | null {
  if (value === undefined) return null
  return asString(value)
}

function checkpointParams(record: CheckpointRecord, whereLabel: string): SqlValue[] {
  const executionId = requireExecutionId(record.executionId, whereLabel)
  return [
    asString(record.id),
    asString(record.agentId),
    asString(record.runId),
    asString(record.sessionId),
    executionId,
    asString(record.toolName),
    asString(record.toolCallId),
    jsonText(record.schema ?? null),
    textOrNull(record.prompt),
    textOrNull(record.skill),
    record.parent != null ? jsonText(record.parent) : null,
    record.pending != null ? jsonText(record.pending) : null,
    record.principal != null ? principalJson(record.principal) : null,
    record.createdAt,
  ]
}

async function insertMessage(
  sql: Sql,
  sessionId: string,
  message: Omit<SessionMessage, 'id' | 'sessionId'>,
): Promise<number> {
  const now = message.timestamp ?? Date.now()
  await executeSql(
    sql,
    'INSERT INTO bread_session_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, CAST(? AS JSON), ?)',
    [uuidv7(), asString(sessionId), asString(message.role), jsonText(message.content), now],
  )
  return now
}

// MySQL BreadStore. store() opens a pool and does not create tables. Call
// migrate() or bread.start() before querying. Keyword search only.
export function store(opts: MysqlStoreOptions = {}): BreadStore {
  const pool = mysqlPool(opts)

  return {
    async createSession(input) {
      return attempt(async () => {
        const id = input?.id === undefined ? uuidv7() : asString(input.id)
        const now = Date.now()
        const tags = tagsJson(input?.tags)
        const principal = input?.principal == null ? null : principalJson(input.principal)
        await executeSql(
          pool,
          'INSERT INTO bread_sessions (id, created_at, updated_at, tags, principal) VALUES (?, ?, ?, CAST(? AS JSON), CAST(? AS JSON))',
          [id, now, now, tags, principal],
        )
        return {
          id,
          createdAt: now,
          updatedAt: now,
          tags: JSON.parse(tags) as Record<string, string>,
          ...(principal != null ? { principal: JSON.parse(principal) as Principal } : {}),
        }
      })
    },

    async claimSessionPrincipal(id, principal) {
      return attempt(async () => {
        const result = await executeSql(
          pool,
          'UPDATE bread_sessions SET principal = CAST(? AS JSON) WHERE id = ? AND principal IS NULL',
          [principalJson(principal), asString(id)],
        )
        return result.affectedRows === 1
      })
    },

    async getSession(id) {
      return attempt(async () => {
        const rows = await selectRows<SessionRow>(pool, 'SELECT * FROM bread_sessions WHERE id = ?', [asString(id)])
        return rows[0] ? rowToSession(rows[0]) : undefined
      })
    },

    async listSessions(filter) {
      return attempt(async () => {
        const rows = filter?.tags
          ? await selectRows<SessionRow>(
              pool,
              'SELECT * FROM bread_sessions WHERE JSON_CONTAINS(tags, CAST(? AS JSON))',
              [tagsJson(filter.tags)],
            )
          : await selectRows<SessionRow>(pool, 'SELECT * FROM bread_sessions')
        return rows.map(rowToSession)
      })
    },

    async deleteSession(id) {
      return attempt(async () => {
        await executeSql(pool, 'DELETE FROM bread_sessions WHERE id = ?', [asString(id)])
      })
    },

    async deleteSessionForPrincipal(id, principal) {
      return attempt(async () => {
        const owner = principalKeys(principal)
        const result = await executeSql(
          pool,
          `DELETE FROM bread_sessions
           WHERE id = ?
             AND principal IS NOT NULL
             AND principal->>'$.iss' = ?
             AND principal->>'$.sub' = ?`,
          [asString(id), owner.iss, owner.sub],
        )
        return result.affectedRows > 0
      })
    },

    async cleanupSessions(options?: CleanupOptions) {
      return attempt(async () => {
        if (!options?.olderThanMs) return 0
        const cutoff = Date.now() - options.olderThanMs
        const clauses = ['updated_at < ?']
        const params: SqlValue[] = [cutoff]
        if (options.tags) {
          clauses.push('JSON_CONTAINS(tags, CAST(? AS JSON))')
          params.push(tagsJson(options.tags))
        }
        if (options.principal) {
          const owner = principalKeys(options.principal)
          clauses.push("principal->>'$.iss' = ?")
          clauses.push("principal->>'$.sub' = ?")
          params.push(owner.iss, owner.sub)
        }
        const result = await executeSql(pool, `DELETE FROM bread_sessions ${where(clauses)}`, params)
        return result.affectedRows
      })
    },

    async getMessages(sessionId) {
      return attempt(async () => {
        const rows = await selectRows<MessageRow>(
          pool,
          'SELECT * FROM bread_session_messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC',
          [asString(sessionId)],
        )
        return rows.map(rowToMessage)
      })
    },

    async addMessage(sessionId, message) {
      return attempt(async () => {
        const id = asString(sessionId)
        const now = await insertMessage(pool, id, message)
        await executeSql(pool, 'UPDATE bread_sessions SET updated_at = ? WHERE id = ?', [now, id])
      })
    },

    async saveCheckpoint(record) {
      return attempt(async () => {
        await executeSql(pool, UPSERT_CHECKPOINT, checkpointParams(record, 'saveCheckpoint'))
      })
    },

    async getCheckpoint(id) {
      return attempt(async () => {
        const rows = await selectRows<CheckpointRow>(pool, 'SELECT * FROM bread_checkpoints WHERE id = ?', [
          asString(id),
        ])
        return rows[0] ? rowToCheckpoint(rows[0]) : undefined
      })
    },

    async claimCheckpoint(id) {
      return attempt(async () => {
        const checkpointId = asString(id)
        return withTransaction(pool, async (conn) => {
          const updated = await executeSql(
            conn,
            'UPDATE bread_checkpoints SET claimed = 1 WHERE id = ? AND claimed = 0',
            [checkpointId],
          )
          if (updated.affectedRows !== 1) return undefined
          const rows = await selectRows<CheckpointRow>(conn, 'SELECT * FROM bread_checkpoints WHERE id = ?', [
            checkpointId,
          ])
          return rows[0] ? rowToCheckpoint(rows[0]) : undefined
        })
      })
    },

    async deleteCheckpoint(id, deleteOpts) {
      return attempt(async () => {
        const checkpointId = asString(id)
        // The DELETE is the claim. FOR UPDATE keeps a second resume from reading the row first.
        const selectSql = deleteOpts?.unclaimedOnly
          ? 'SELECT * FROM bread_checkpoints WHERE id = ? AND claimed = 0 FOR UPDATE'
          : 'SELECT * FROM bread_checkpoints WHERE id = ? FOR UPDATE'
        const deleteSql = deleteOpts?.unclaimedOnly
          ? 'DELETE FROM bread_checkpoints WHERE id = ? AND claimed = 0'
          : 'DELETE FROM bread_checkpoints WHERE id = ?'
        return withTransaction(pool, async (conn) => {
          const rows = await selectRows<CheckpointRow>(conn, selectSql, [checkpointId])
          const row = rows[0]
          if (!row) return undefined
          await executeSql(conn, deleteSql, [checkpointId])
          return rowToCheckpoint(row)
        })
      })
    },

    async listCheckpoints(filter) {
      return attempt(async () => {
        const executionId = filter && requireExecutionId(filter.executionId, 'listCheckpoints')
        const rows =
          executionId === undefined
            ? await selectRows<CheckpointRow>(pool, 'SELECT * FROM bread_checkpoints ORDER BY created_at ASC')
            : await selectRows<CheckpointRow>(
                pool,
                'SELECT * FROM bread_checkpoints WHERE execution_id = ? ORDER BY created_at ASC',
                [executionId],
              )
        return rows.map(rowToCheckpoint)
      })
    },

    async suspendRun(sessionId, messages, checkpoint) {
      return attempt(async () => {
        const id = asString(sessionId)
        const params = checkpointParams(checkpoint, 'suspendRun')
        await withTransaction(pool, async (conn) => {
          let last = checkpoint.createdAt
          for (const message of messages) last = await insertMessage(conn, id, message)
          await executeSql(conn, 'UPDATE bread_sessions SET updated_at = ? WHERE id = ?', [last, id])
          await executeSql(conn, UPSERT_CHECKPOINT, params)
        })
      })
    },

    async createLoop(record) {
      return attempt(async () => {
        await executeSql(
          pool,
          `INSERT INTO bread_loops
            (id, agent_id, session_id, run_id, pool, pipeline, max_iterations, status, iterations, result, started_at, completed_at)
           VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, CAST(? AS JSON), ?, ?)`,
          [
            asString(record.id),
            asString(record.agentId),
            asString(record.sessionId),
            asString(record.runId),
            jsonText(record.pool),
            jsonText(record.pipeline),
            record.maxIterations,
            asString(record.status),
            record.iterations,
            record.result === undefined ? null : jsonText(record.result),
            record.startedAt,
            record.completedAt ?? null,
          ],
        )
      })
    },

    async updateLoop(id, patch) {
      return attempt(async () => {
        const loopId = asString(id)
        if (patch.status !== undefined) {
          await executeSql(pool, 'UPDATE bread_loops SET status = ? WHERE id = ?', [asString(patch.status), loopId])
        }
        if (patch.iterations !== undefined) {
          await executeSql(pool, 'UPDATE bread_loops SET iterations = ? WHERE id = ?', [patch.iterations, loopId])
        }
        if (patch.result !== undefined) {
          await executeSql(pool, 'UPDATE bread_loops SET result = CAST(? AS JSON) WHERE id = ?', [
            jsonText(patch.result),
            loopId,
          ])
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lastOutput')) {
          await executeSql(pool, 'UPDATE bread_loops SET last_output = CAST(? AS JSON) WHERE id = ?', [
            jsonText(encodeLastOutput(patch.lastOutput)),
            loopId,
          ])
        }
        if (patch.completedAt !== undefined) {
          await executeSql(pool, 'UPDATE bread_loops SET completed_at = ? WHERE id = ?', [patch.completedAt, loopId])
        }
      })
    },

    async addLoopIteration(iteration) {
      return attempt(async () => {
        await executeSql(
          pool,
          `INSERT INTO bread_loop_iterations (id, loop_id, idx, input, output, started_at, completed_at)
           VALUES (?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?)`,
          [
            asString(iteration.id),
            asString(iteration.loopId),
            iteration.index,
            iteration.input === undefined ? null : jsonText(iteration.input),
            iteration.output === undefined ? null : jsonText(iteration.output),
            iteration.startedAt,
            iteration.completedAt,
          ],
        )
      })
    },

    async getLoop(id) {
      return attempt(async () => {
        const loopId = asString(id)
        const rows = await selectRows<LoopRow>(pool, 'SELECT * FROM bread_loops WHERE id = ?', [loopId])
        const row = rows[0]
        if (!row) return undefined
        const iterations = await selectRows<LoopIterationRow>(
          pool,
          'SELECT * FROM bread_loop_iterations WHERE loop_id = ? ORDER BY idx ASC',
          [loopId],
        )
        return { loop: rowToLoop(row), iterations: iterations.map(rowToLoopIteration) }
      })
    },

    async listLoops(filter?: LoopFilter) {
      return attempt(async () => {
        const clauses: string[] = []
        const params: SqlValue[] = []
        if (filter?.sessionId !== undefined) {
          clauses.push('session_id = ?')
          params.push(asString(filter.sessionId))
        }
        if (filter?.agentId !== undefined) {
          clauses.push('agent_id = ?')
          params.push(asString(filter.agentId))
        }
        if (filter?.status !== undefined) {
          clauses.push('status = ?')
          params.push(asString(filter.status))
        }
        const rows = await selectRows<LoopRow>(
          pool,
          `SELECT * FROM bread_loops ${where(clauses)} ORDER BY started_at DESC`,
          params,
        )
        return rows.map(rowToLoop)
      })
    },

    async createTaskRun(record) {
      return attempt(async () => {
        await executeSql(
          pool,
          `INSERT INTO bread_task_runs
            (id, task_id, agent_id, session_id, run_id, model, input, output, status, \`usage\`, error, duration_ms, created_at, completed_at)
           VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, CAST(? AS JSON), ?, ?, ?, ?)`,
          [
            asString(record.id),
            asString(record.taskId),
            textOrNull(record.agentId),
            textOrNull(record.sessionId),
            textOrNull(record.runId),
            jsonText(record.model),
            record.input === undefined ? null : jsonText(record.input),
            record.output === undefined ? null : jsonText(record.output),
            asString(record.status),
            record.usage === undefined ? null : jsonText(record.usage),
            textOrNull(record.error),
            record.durationMs ?? null,
            record.createdAt,
            record.completedAt ?? null,
          ],
        )
      })
    },

    async finishTaskRun(id, patch) {
      return attempt(async () => {
        const runId = asString(id)
        if (patch.status !== undefined) {
          await executeSql(pool, 'UPDATE bread_task_runs SET status = ? WHERE id = ?', [asString(patch.status), runId])
        }
        if (patch.output !== undefined) {
          await executeSql(pool, 'UPDATE bread_task_runs SET output = CAST(? AS JSON) WHERE id = ?', [
            jsonText(patch.output),
            runId,
          ])
        }
        if (patch.usage !== undefined) {
          await executeSql(pool, 'UPDATE bread_task_runs SET `usage` = CAST(? AS JSON) WHERE id = ?', [
            jsonText(patch.usage),
            runId,
          ])
        }
        if (patch.error !== undefined) {
          await executeSql(pool, 'UPDATE bread_task_runs SET error = ? WHERE id = ?', [asString(patch.error), runId])
        }
        if (patch.durationMs !== undefined) {
          await executeSql(pool, 'UPDATE bread_task_runs SET duration_ms = ? WHERE id = ?', [patch.durationMs, runId])
        }
        if (patch.completedAt !== undefined) {
          await executeSql(pool, 'UPDATE bread_task_runs SET completed_at = ? WHERE id = ?', [patch.completedAt, runId])
        }
      })
    },

    async getTaskRun(id) {
      return attempt(async () => {
        const rows = await selectRows<TaskRunRow>(pool, 'SELECT * FROM bread_task_runs WHERE id = ?', [asString(id)])
        return rows[0] ? rowToTaskRun(rows[0]) : undefined
      })
    },

    async listTaskRuns(filter?: TaskRunFilter) {
      return attempt(async () => {
        const clauses: string[] = []
        const params: SqlValue[] = []
        if (filter?.taskId !== undefined) {
          clauses.push('task_id = ?')
          params.push(asString(filter.taskId))
        }
        if (filter?.agentId !== undefined) {
          clauses.push('agent_id = ?')
          params.push(asString(filter.agentId))
        }
        if (filter?.sessionId !== undefined) {
          clauses.push('session_id = ?')
          params.push(asString(filter.sessionId))
        }
        if (filter?.status !== undefined) {
          clauses.push('status = ?')
          params.push(asString(filter.status))
        }
        params.push(limitParam(filter?.limit, LIMIT_MAX))
        const rows = await selectRows<TaskRunRow>(
          pool,
          `SELECT * FROM bread_task_runs ${where(clauses)} ORDER BY created_at DESC LIMIT ?`,
          params,
        )
        return rows.map(rowToTaskRun)
      })
    },

    async appendCrumbs(entries) {
      return attempt(async () => {
        await withTransaction(pool, async (conn) => {
          for (const entry of entries) {
            await executeSql(
              conn,
              `INSERT INTO bread_crumbs (run_id, seq, session_id, agent_id, type, crumb, created_at)
               VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
              [
                asString(entry.runId),
                entry.seq,
                entry.sessionId === undefined ? null : asString(entry.sessionId),
                entry.agentId === undefined ? null : asString(entry.agentId),
                asString(entry.type),
                jsonText(entry.crumb),
                entry.createdAt,
              ],
            )
          }
        })
      })
    },

    async getCrumbs(runId, crumbOpts) {
      return attempt(async () => {
        const after = crumbOpts?.afterSeq ?? 0
        if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
          throw new BreadError('Cursor is invalid.', 'INVALID_CURSOR', {})
        }
        const rows = await selectRows<CrumbRow>(
          pool,
          `SELECT * FROM bread_crumbs WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
          [asString(runId), after, limitParam(crumbOpts?.limit, LIMIT_MAX)],
        )
        return rows.map(rowToCrumb)
      })
    },

    async getMaxCrumbSeq(runId) {
      return attempt(async () => {
        const rows = await selectRows<RowDataPacket>(
          pool,
          'SELECT MAX(seq) AS max FROM bread_crumbs WHERE run_id = ?',
          [asString(runId)],
        )
        return rows[0]?.max == null ? 0 : Number(rows[0].max)
      })
    },

    async addMemory({ agentId, principal, content }) {
      return attempt(async () => {
        const id = uuidv7()
        const now = Date.now()
        const owner = principalKeys(principal)
        await executeSql(
          pool,
          `INSERT INTO bread_memories (id, agent_id, principal_iss, principal_sub, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, asString(agentId), owner.iss, owner.sub, asString(content), now],
        )
        return { id, content, createdAt: now }
      })
    },

    async searchMemories({ agentId, principal, query, limit }) {
      return attempt(async () => {
        const owner = principalKeys(principal)
        const rows = await selectRows<RowDataPacket>(
          pool,
          `SELECT id, content, created_at FROM bread_memories
           WHERE agent_id = ? AND principal_iss = ? AND principal_sub = ? AND content ${LIKE}
           ORDER BY created_at DESC LIMIT ?`,
          [asString(agentId), owner.iss, owner.sub, likeContains(query), limitParam(limit, 10)],
        )
        return rows.map(
          (row): MemoryRecord => ({ id: String(row.id), content: String(row.content), createdAt: Number(row.created_at) }),
        )
      })
    },

    async listMemories({ agentId, principal, limit }) {
      return attempt(async () => {
        const owner = principalKeys(principal)
        const rows = await selectRows<RowDataPacket>(
          pool,
          `SELECT id, content, created_at FROM bread_memories
           WHERE agent_id = ? AND principal_iss = ? AND principal_sub = ?
           ORDER BY created_at DESC LIMIT ?`,
          [asString(agentId), owner.iss, owner.sub, limitParam(limit, LIMIT_MAX)],
        )
        return rows.map(
          (row): MemoryRecord => ({ id: String(row.id), content: String(row.content), createdAt: Number(row.created_at) }),
        )
      })
    },

    async forgetMemory({ agentId, principal, id }) {
      return attempt(async () => {
        const owner = principalKeys(principal)
        const result = await executeSql(
          pool,
          `DELETE FROM bread_memories
           WHERE id = ? AND agent_id = ? AND principal_iss = ? AND principal_sub = ?`,
          [asString(id), asString(agentId), owner.iss, owner.sub],
        )
        return { deleted: result.affectedRows > 0 }
      })
    },

    async ingestDocument({ agentId, title, content, source }) {
      return attempt(async () => {
        const id = uuidv7()
        await executeSql(
          pool,
          `INSERT INTO bread_documents (id, agent_id, title, content, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, asString(agentId), asString(title), asString(content), textOrNull(source), Date.now()],
        )
        return { id, title }
      })
    },

    async searchDocuments({ agentId, query, limit }) {
      return attempt(async () => {
        const pattern = likeContains(query)
        const rows = await selectRows<RowDataPacket>(
          pool,
          `SELECT id, title, source FROM bread_documents
           WHERE agent_id = ? AND (title ${LIKE} OR content ${LIKE})
           LIMIT ?`,
          [asString(agentId), pattern, pattern, limitParam(limit, 5)],
        )
        return rows.map(
          (row): DocumentRecord => ({
            id: String(row.id),
            title: String(row.title),
            source: row.source == null ? null : String(row.source),
          }),
        )
      })
    },

    async readDocument({ agentId, id }) {
      return attempt(async () => {
        const rows = await selectRows<RowDataPacket>(
          pool,
          'SELECT title, content FROM bread_documents WHERE id = ? AND agent_id = ?',
          [asString(id), asString(agentId)],
        )
        const row = rows[0]
        return row ? { title: String(row.title), content: String(row.content) } : undefined
      })
    },

    async migrate() {
      return attempt(async () => {
        const plan = mysqlMigration(pool)
        return runMigrations(plan.journal, plan.steps, plan.knownIds)
      })
    },

    async migrations() {
      return attempt(async () => {
        const plan = mysqlMigration(pool)
        return readMigrationStatus(plan.journal, plan.steps, plan.knownIds)
      })
    },

    async close() {
      await pool.end()
    },
  }
}
