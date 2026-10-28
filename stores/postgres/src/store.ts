import postgres from 'postgres'
import { v7 as uuidv7 } from 'uuid'
import {
  decodeLastOutput,
  rerankHits,
  type BreadStore,
  type CheckpointRecord,
  type CleanupOptions,
  type CrumbLogEntry,
  type DocumentRecord,
  type KnowledgeNode,
  type LoopIteration,
  type LoopRecord,
  type LoopStatus,
  type RerankRef,
  type RerankingRegistry,
  type Session,
  type SessionMessage,
  type TaskRunRecord,
  type TaskRunStatus,
  encodeLastOutput,
} from '@breadai/core'
import { requireExecutionId } from '@breadai/core'
import { migrate } from './migrate.js'

export type EmbedFn = (text: string) => Promise<number[]>

export interface PostgresStoreOptions {
  // Connection string. Defaults to process.env.DATABASE_URL; throws if neither.
  url?: string
  // Optional embedder. When set, documents and knowledge nodes are embedded on
  // write and searched by cosine similarity via pgvector; otherwise search is
  // keyword-based (ILIKE).
  embed?: EmbedFn
  // When set, search loads candidate text and reranks before applying limit.
  // bread.start() binds config.reranking. With no ref, order stays as retrieved.
  rerank?: RerankRef
}

export interface PostgresStore extends BreadStore {
  // Undefined leaves a previous bind in place so start() without a registry
  // does not clear one the caller already set.
  bindReranking(registry: RerankingRegistry | undefined): void
}

interface SessionRow {
  id: string
  created_at: string
  updated_at: string
  agent_id: string | null
  tags: Record<string, string>
  principal: unknown
}

interface MessageRow {
  id: string
  session_id: string
  role: string
  content: unknown
  timestamp: string
}

interface CheckpointRow {
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
  created_at: string
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    tags: r.tags ?? {},
    ...(r.agent_id ? { agentId: r.agent_id } : {}),
    ...(r.principal != null ? { principal: r.principal as NonNullable<Session['principal']> } : {}),
  }
}

function rowToMessage(r: MessageRow): SessionMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as SessionMessage['role'],
    content: r.content,
    timestamp: Number(r.timestamp),
  }
}

function rowToCheckpoint(r: CheckpointRow): CheckpointRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    runId: r.run_id,
    sessionId: r.session_id,
    executionId: r.execution_id,
    toolName: r.tool_name,
    toolCallId: r.tool_call_id,
    schema: r.schema,
    ...(r.prompt != null ? { prompt: r.prompt } : {}),
    ...(r.skill != null ? { skill: r.skill } : {}),
    ...(r.parent != null ? { parent: r.parent as CheckpointRecord['parent'] } : {}),
    ...(r.pending != null ? { pending: r.pending as CheckpointRecord['pending'] } : {}),
    ...(r.principal != null ? { principal: r.principal as CheckpointRecord['principal'] } : {}),
    createdAt: Number(r.created_at),
  }
}

interface LoopRow {
  id: string
  agent_id: string
  session_id: string
  run_id: string
  pool: string[]
  pipeline: string[]
  max_iterations: number
  status: string
  iterations: number
  result: unknown
  last_output: unknown
  started_at: string
  completed_at: string | null
}

interface LoopIterationRow {
  id: string
  loop_id: string
  idx: number
  input: unknown
  output: unknown
  started_at: string
  completed_at: string
}

function rowToLoop(r: LoopRow): LoopRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    sessionId: r.session_id,
    runId: r.run_id,
    pool: r.pool ?? [],
    pipeline: r.pipeline ?? [],
    maxIterations: Number(r.max_iterations),
    status: r.status as LoopStatus,
    iterations: Number(r.iterations),
    ...(r.result != null ? { result: r.result } : {}),
    ...readLastOutput(r.last_output),
    startedAt: Number(r.started_at),
    ...(r.completed_at != null ? { completedAt: Number(r.completed_at) } : {}),
  }
}

function readLastOutput(raw: unknown): { lastOutput: unknown } | Record<string, never> {
  const decoded = decodeLastOutput(raw)
  return decoded.present ? { lastOutput: decoded.value } : {}
}

function rowToLoopIteration(r: LoopIterationRow): LoopIteration {
  return {
    id: r.id,
    loopId: r.loop_id,
    index: Number(r.idx),
    input: r.input,
    output: r.output,
    startedAt: Number(r.started_at),
    completedAt: Number(r.completed_at),
  }
}

interface TaskRunRow {
  id: string
  task_id: string
  agent_id: string | null
  session_id: string | null
  run_id: string | null
  model: { provider: string; model: string }
  input: unknown
  output: unknown
  status: string
  usage: TaskRunRecord['usage']
  error: string | null
  duration_ms: number | null
  created_at: string
  completed_at: string | null
}

function rowToTaskRun(r: TaskRunRow): TaskRunRecord {
  return {
    id: r.id,
    taskId: r.task_id,
    ...(r.agent_id != null ? { agentId: r.agent_id } : {}),
    ...(r.session_id != null ? { sessionId: r.session_id } : {}),
    ...(r.run_id != null ? { runId: r.run_id } : {}),
    model: r.model,
    input: r.input,
    ...(r.output != null ? { output: r.output } : {}),
    status: r.status as TaskRunStatus,
    ...(r.usage != null ? { usage: r.usage } : {}),
    ...(r.error != null ? { error: r.error } : {}),
    ...(r.duration_ms != null ? { durationMs: Number(r.duration_ms) } : {}),
    createdAt: Number(r.created_at),
    ...(r.completed_at != null ? { completedAt: Number(r.completed_at) } : {}),
  }
}

interface CrumbRow {
  run_id: string
  seq: string
  session_id: string | null
  agent_id: string | null
  type: string
  crumb: unknown
  created_at: string
}

function rowToCrumbEntry(r: CrumbRow): CrumbLogEntry {
  return {
    runId: r.run_id,
    seq: Number(r.seq),
    ...(r.session_id != null ? { sessionId: r.session_id } : {}),
    ...(r.agent_id != null ? { agentId: r.agent_id } : {}),
    type: r.type,
    crumb: r.crumb,
    createdAt: Number(r.created_at),
  }
}

// pgvector literal: a number[] serializes to `[0.1,0.2,…]`, cast to ::vector.
function vec(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

// The default BreadStore: PostgreSQL via postgres.js. All tables are `bread_`
// prefixed and created by migrate(). Pass `embed` to enable pgvector semantic
// search over documents and knowledge nodes. Pass `rerank` to rescore those
// hits; bread.start() supplies config.reranking.
export function store(opts: PostgresStoreOptions = {}): PostgresStore {
  const url = opts.url ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'store: no connection string. Pass `url` or set DATABASE_URL ' +
        '(e.g. postgres://user:pass@host:5432/db).',
    )
  }
  const embed = opts.embed
  const rerankRef = opts.rerank
  let registry: RerankingRegistry | undefined
  const sql = postgres(url)
  // postgres.js's JSONValue type is narrower than our stored shapes (arbitrary
  // record/unknown content); this wraps the jsonb helper for our call sites.
  const j = (v: unknown) => sql.json(v as never)
  // Composes optional `sql` fragments into `WHERE a AND b AND c` (or an empty
  // fragment when none apply) — the postgres.js-idiomatic way to build a
  // dynamic WHERE clause while keeping every value tagged-template parameterized.
  const where = (conds: postgres.Fragment[]) =>
    conds.length
      ? sql`WHERE ${conds.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`))}`
      : sql``

  return {
    // --- Sessions ------------------------------------------------------------
    async createSession(o) {
      const id = o?.id ?? uuidv7()
      const now = Date.now()
      const tags = o?.tags ?? {}
      await sql`INSERT INTO bread_sessions (id, created_at, updated_at, tags, principal)
                VALUES (${id}, ${now}, ${now}, ${j(tags)}, ${o?.principal != null ? j(o.principal) : null})`
      return {
        id,
        createdAt: now,
        updatedAt: now,
        tags,
        ...(o?.principal ? { principal: o.principal } : {}),
      }
    },

    async claimSessionPrincipal(id, principal) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE bread_sessions
        SET principal = ${j(principal)}
        WHERE id = ${id} AND principal IS NULL
        RETURNING id`
      return rows.length === 1
    },

    async getSession(id) {
      const rows = await sql<SessionRow[]>`SELECT * FROM bread_sessions WHERE id = ${id}`
      return rows[0] ? rowToSession(rows[0]) : undefined
    },

    async listSessions(filter) {
      // JSONB containment (`@>`) matches session filtering semantics: every
      // requested tag key/value must be present in the row's tags.
      const conds = filter?.tags ? [sql`tags @> ${j(filter.tags)}`] : []
      const rows = await sql<SessionRow[]>`SELECT * FROM bread_sessions ${where(conds)}`
      return rows.map(rowToSession)
    },

    async deleteSession(id) {
      await sql`DELETE FROM bread_sessions WHERE id = ${id}`
    },

    async deleteSessionForPrincipal(id, principal) {
      const rows = await sql<Array<{ id: string }>>`
        DELETE FROM bread_sessions
        WHERE id = ${id}
          AND principal IS NOT NULL
          AND principal->>'iss' = ${principal.iss}
          AND principal->>'sub' = ${principal.sub}
        RETURNING id`
      return rows.length === 1
    },

    async cleanupSessions(opts?: CleanupOptions) {
      // No olderThanMs: nothing qualifies (tags alone never delete) — matches
      // the JS-filter semantics this replaces, without issuing a DELETE at all.
      if (!opts?.olderThanMs) return 0
      const cutoff = Date.now() - opts.olderThanMs
      const conds = [sql`updated_at < ${cutoff}`, ...(opts.tags ? [sql`tags @> ${j(opts.tags)}`] : [])]
      if (opts.principal) {
        // iss and sub only. A null principal does not match, and tenant is not compared.
        conds.push(sql`principal->>'iss' = ${opts.principal.iss}`)
        conds.push(sql`principal->>'sub' = ${opts.principal.sub}`)
      }
      const rows = await sql<Array<{ id: string }>>`
        DELETE FROM bread_sessions ${where(conds)} RETURNING id`
      return rows.length
    },

    async getMessages(sessionId) {
      const rows = await sql<MessageRow[]>`
        SELECT * FROM bread_session_messages WHERE session_id = ${sessionId}
        ORDER BY timestamp ASC, id ASC`
      return rows.map(rowToMessage)
    },

    async addMessage(sessionId, message) {
      const now = message.timestamp ?? Date.now()
      // v7: sortable, monotonic id so the turn's messages keep order under the
      // (timestamp, id) sort even when written within the same millisecond.
      await sql`INSERT INTO bread_session_messages (id, session_id, role, content, timestamp)
                VALUES (${uuidv7()}, ${sessionId}, ${message.role}, ${j(message.content)}, ${now})`
      await sql`UPDATE bread_sessions SET updated_at = ${now} WHERE id = ${sessionId}`
    },

    // --- Checkpoints ---------------------------------------------------------
    async saveCheckpoint(r) {
      requireExecutionId(r.executionId, 'saveCheckpoint')
      await sql`
        INSERT INTO bread_checkpoints (id, agent_id, run_id, session_id, execution_id, tool_name, tool_call_id, schema, prompt, skill, parent, pending, principal, created_at)
        VALUES (${r.id}, ${r.agentId}, ${r.runId}, ${r.sessionId}, ${r.executionId}, ${r.toolName}, ${r.toolCallId}, ${j(
          r.schema ?? null,
        )}, ${r.prompt ?? null}, ${r.skill ?? null}, ${r.parent != null ? j(r.parent) : null}, ${
          r.pending != null ? j(r.pending) : null
        }, ${r.principal != null ? j(r.principal) : null}, ${r.createdAt})
        ON CONFLICT (id) DO UPDATE SET
          agent_id = EXCLUDED.agent_id, run_id = EXCLUDED.run_id, session_id = EXCLUDED.session_id, execution_id = EXCLUDED.execution_id,
          tool_name = EXCLUDED.tool_name, tool_call_id = EXCLUDED.tool_call_id,
          schema = EXCLUDED.schema, prompt = EXCLUDED.prompt, skill = EXCLUDED.skill,
          parent = EXCLUDED.parent, pending = EXCLUDED.pending, principal = EXCLUDED.principal, created_at = EXCLUDED.created_at`
    },

    async getCheckpoint(id) {
      const rows = await sql<CheckpointRow[]>`SELECT * FROM bread_checkpoints WHERE id = ${id}`
      return rows[0] ? rowToCheckpoint(rows[0]) : undefined
    },

    async claimCheckpoint(id) {
      const rows = await sql<CheckpointRow[]>`
        UPDATE bread_checkpoints SET claimed = 1 WHERE id = ${id} AND claimed = 0 RETURNING *`
      return rows[0] ? rowToCheckpoint(rows[0]) : undefined
    },

    async deleteCheckpoint(id, opts) {
      const rows = opts?.unclaimedOnly
        ? await sql<CheckpointRow[]>`DELETE FROM bread_checkpoints WHERE id = ${id} AND claimed = 0 RETURNING *`
        : await sql<CheckpointRow[]>`DELETE FROM bread_checkpoints WHERE id = ${id} RETURNING *`
      return rows[0] ? rowToCheckpoint(rows[0]) : undefined
    },

    async listCheckpoints(filter) {
      const executionId = filter && requireExecutionId(filter.executionId, 'listCheckpoints')
      const rows =
        executionId === undefined
          ? await sql<CheckpointRow[]>`SELECT * FROM bread_checkpoints ORDER BY created_at ASC`
          : await sql<CheckpointRow[]>`
              SELECT * FROM bread_checkpoints WHERE execution_id = ${executionId} ORDER BY created_at ASC`
      return rows.map(rowToCheckpoint)
    },

    async suspendRun(sessionId, msgs, checkpoint) {
      requireExecutionId(checkpoint.executionId, 'suspendRun')
      // Transactional: a crash between persisting the response messages and the
      // checkpoint must not leave a dangling tool-call with nothing to resume it.
      await sql.begin(async (tx) => {
        let last = checkpoint.createdAt
        for (const m of msgs) {
          const now = m.timestamp ?? Date.now()
          await tx`INSERT INTO bread_session_messages (id, session_id, role, content, timestamp)
                    VALUES (${uuidv7()}, ${sessionId}, ${m.role}, ${j(m.content)}, ${now})`
          last = now
        }
        await tx`UPDATE bread_sessions SET updated_at = ${last} WHERE id = ${sessionId}`
        await tx`
          INSERT INTO bread_checkpoints (id, agent_id, run_id, session_id, execution_id, tool_name, tool_call_id, schema, prompt, skill, parent, pending, principal, created_at)
          VALUES (${checkpoint.id}, ${checkpoint.agentId}, ${checkpoint.runId}, ${checkpoint.sessionId}, ${checkpoint.executionId},
            ${checkpoint.toolName}, ${checkpoint.toolCallId}, ${j(checkpoint.schema ?? null)},
            ${checkpoint.prompt ?? null}, ${checkpoint.skill ?? null},
            ${checkpoint.parent != null ? j(checkpoint.parent) : null},
            ${checkpoint.pending != null ? j(checkpoint.pending) : null},
            ${checkpoint.principal != null ? j(checkpoint.principal) : null}, ${checkpoint.createdAt})
          ON CONFLICT (id) DO UPDATE SET
            agent_id = EXCLUDED.agent_id, run_id = EXCLUDED.run_id, session_id = EXCLUDED.session_id, execution_id = EXCLUDED.execution_id,
            tool_name = EXCLUDED.tool_name, tool_call_id = EXCLUDED.tool_call_id,
            schema = EXCLUDED.schema, prompt = EXCLUDED.prompt, skill = EXCLUDED.skill,
            parent = EXCLUDED.parent, pending = EXCLUDED.pending, principal = EXCLUDED.principal, created_at = EXCLUDED.created_at`
      })
    },

    // --- Loops ---------------------------------------------------------------
    async createLoop(r) {
      await sql`
        INSERT INTO bread_loops
          (id, agent_id, session_id, run_id, pool, pipeline, max_iterations, status, iterations, result, started_at, completed_at)
        VALUES (${r.id}, ${r.agentId}, ${r.sessionId}, ${r.runId}, ${j(r.pool)}, ${j(r.pipeline)},
          ${r.maxIterations}, ${r.status}, ${r.iterations}, ${
            r.result === undefined ? null : j(r.result)
          }, ${r.startedAt}, ${r.completedAt ?? null})`
    },

    async updateLoop(id, patch) {
      if (patch.status !== undefined)
        await sql`UPDATE bread_loops SET status = ${patch.status} WHERE id = ${id}`
      if (patch.iterations !== undefined)
        await sql`UPDATE bread_loops SET iterations = ${patch.iterations} WHERE id = ${id}`
      if (patch.result !== undefined)
        await sql`UPDATE bread_loops SET result = ${j(patch.result)} WHERE id = ${id}`
      if (Object.prototype.hasOwnProperty.call(patch, 'lastOutput'))
        await sql`UPDATE bread_loops SET last_output = ${j(encodeLastOutput(patch.lastOutput))} WHERE id = ${id}`
      if (patch.completedAt !== undefined)
        await sql`UPDATE bread_loops SET completed_at = ${patch.completedAt} WHERE id = ${id}`
    },

    async addLoopIteration(it) {
      await sql`
        INSERT INTO bread_loop_iterations (id, loop_id, idx, input, output, started_at, completed_at)
        VALUES (${it.id}, ${it.loopId}, ${it.index}, ${
          it.input === undefined ? null : j(it.input)
        }, ${it.output === undefined ? null : j(it.output)}, ${it.startedAt}, ${it.completedAt})`
    },

    async getLoop(id) {
      const rows = await sql<LoopRow[]>`SELECT * FROM bread_loops WHERE id = ${id}`
      if (!rows[0]) return undefined
      const iters = await sql<LoopIterationRow[]>`
        SELECT * FROM bread_loop_iterations WHERE loop_id = ${id} ORDER BY idx ASC`
      return { loop: rowToLoop(rows[0]), iterations: iters.map(rowToLoopIteration) }
    },

    async listLoops(filter) {
      const conds = [
        ...(filter?.sessionId ? [sql`session_id = ${filter.sessionId}`] : []),
        ...(filter?.agentId ? [sql`agent_id = ${filter.agentId}`] : []),
        ...(filter?.status ? [sql`status = ${filter.status}`] : []),
      ]
      const rows = await sql<LoopRow[]>`
        SELECT * FROM bread_loops ${where(conds)} ORDER BY started_at DESC`
      return rows.map(rowToLoop)
    },

    // --- Task runs (audit) ---------------------------------------------------
    async createTaskRun(r) {
      await sql`
        INSERT INTO bread_task_runs
          (id, task_id, agent_id, session_id, run_id, model, input, output, status, usage, error, duration_ms, created_at, completed_at)
        VALUES (${r.id}, ${r.taskId}, ${r.agentId ?? null}, ${r.sessionId ?? null}, ${r.runId ?? null},
          ${j(r.model)}, ${r.input === undefined ? null : j(r.input)},
          ${r.output === undefined ? null : j(r.output)}, ${r.status},
          ${r.usage === undefined ? null : j(r.usage)}, ${r.error ?? null}, ${r.durationMs ?? null},
          ${r.createdAt}, ${r.completedAt ?? null})`
    },

    async finishTaskRun(id, patch) {
      if (patch.status !== undefined)
        await sql`UPDATE bread_task_runs SET status = ${patch.status} WHERE id = ${id}`
      if (patch.output !== undefined)
        await sql`UPDATE bread_task_runs SET output = ${j(patch.output)} WHERE id = ${id}`
      if (patch.usage !== undefined)
        await sql`UPDATE bread_task_runs SET usage = ${j(patch.usage)} WHERE id = ${id}`
      if (patch.error !== undefined)
        await sql`UPDATE bread_task_runs SET error = ${patch.error} WHERE id = ${id}`
      if (patch.durationMs !== undefined)
        await sql`UPDATE bread_task_runs SET duration_ms = ${patch.durationMs} WHERE id = ${id}`
      if (patch.completedAt !== undefined)
        await sql`UPDATE bread_task_runs SET completed_at = ${patch.completedAt} WHERE id = ${id}`
    },

    async getTaskRun(id) {
      const rows = await sql<TaskRunRow[]>`SELECT * FROM bread_task_runs WHERE id = ${id}`
      return rows[0] ? rowToTaskRun(rows[0]) : undefined
    },

    async listTaskRuns(filter) {
      const conds = [
        ...(filter?.taskId ? [sql`task_id = ${filter.taskId}`] : []),
        ...(filter?.agentId ? [sql`agent_id = ${filter.agentId}`] : []),
        ...(filter?.sessionId ? [sql`session_id = ${filter.sessionId}`] : []),
        ...(filter?.status ? [sql`status = ${filter.status}`] : []),
      ]
      const limit = filter?.limit ? sql`LIMIT ${filter.limit}` : sql``
      const rows = await sql<TaskRunRow[]>`
        SELECT * FROM bread_task_runs ${where(conds)} ORDER BY created_at DESC ${limit}`
      return rows.map(rowToTaskRun)
    },

    // --- Crumb run-log ---------------------------------------------------------
    async appendCrumbs(entries) {
      // Transactional: a mid-batch failure (e.g. a bad session_id FK) must not
      // leave a partial write in the durable crumb log — all-or-nothing, same
      // durability contract as the SQLite store's db.transaction(...).
      await sql.begin(async (tx) => {
        for (const e of entries) {
          await tx`
            INSERT INTO bread_crumbs (run_id, seq, session_id, agent_id, type, crumb, created_at)
            VALUES (${e.runId}, ${e.seq}, ${e.sessionId ?? null}, ${e.agentId ?? null},
              ${e.type}, ${j(e.crumb)}, ${e.createdAt})`
        }
      })
    },

    async getCrumbs(runId, opts) {
      const after = opts?.afterSeq ?? 0
      const rows = opts?.limit
        ? await sql<CrumbRow[]>`
            SELECT * FROM bread_crumbs WHERE run_id = ${runId} AND seq > ${after}
            ORDER BY seq ASC LIMIT ${opts.limit}`
        : await sql<CrumbRow[]>`
            SELECT * FROM bread_crumbs WHERE run_id = ${runId} AND seq > ${after}
            ORDER BY seq ASC`
      return rows.map(rowToCrumbEntry)
    },

    async getMaxCrumbSeq(runId) {
      const rows = await sql<Array<{ max: string | null }>>`
        SELECT MAX(seq) AS max FROM bread_crumbs WHERE run_id = ${runId}`
      return rows[0]?.max != null ? Number(rows[0].max) : 0
    },

    // --- Knowledge graph -----------------------------------------------------
    async addKnowledgeNode({ agentId, sessionId, label, data }) {
      const id = uuidv7()
      const now = Date.now()
      if (embed) {
        const e = vec(await embed(label))
        await sql`INSERT INTO bread_kg_nodes (id, agent_id, session_id, label, data, embedding, created_at)
                  VALUES (${id}, ${agentId}, ${sessionId}, ${label}, ${j(data ?? {})}, ${e}::vector, ${now})`
      } else {
        await sql`INSERT INTO bread_kg_nodes (id, agent_id, session_id, label, data, created_at)
                  VALUES (${id}, ${agentId}, ${sessionId}, ${label}, ${j(data ?? {})}, ${now})`
      }
      return { id, label }
    },

    async addKnowledgeEdge({ fromId, toId, relation }) {
      await sql`INSERT INTO bread_kg_edges (id, from_id, to_id, relation)
                VALUES (${uuidv7()}, ${fromId}, ${toId}, ${relation})`
    },

    async queryKnowledge({ agentId, query, limit }) {
      const n = limit ?? 10
      // Limit applies after rerank. Cutting the candidate page in SQL would
      // drop a hit the reranker would have kept.
      if (rerankRef) {
        const rows = embed
          ? await sql<Array<{ id: string; label: string; data: Record<string, unknown> }>>`
              SELECT id, label, data FROM bread_kg_nodes
              WHERE agent_id = ${agentId} AND embedding IS NOT NULL
              ORDER BY embedding <=> ${vec(await embed(query))}::vector`
          : await sql<Array<{ id: string; label: string; data: Record<string, unknown> }>>`
              SELECT id, label, data FROM bread_kg_nodes
              WHERE agent_id = ${agentId} AND label ILIKE ${`%${query}%`}
              ORDER BY created_at DESC`
        const ordered = await rerankHits({
          query,
          hits: rows,
          text: (row) => row.label,
          ref: rerankRef,
          registry,
          limit: n,
        })
        return ordered.map((r): KnowledgeNode => ({ id: r.id, label: r.label, data: r.data ?? {} }))
      }
      const rows = embed
        ? await sql<Array<{ id: string; label: string; data: Record<string, unknown> }>>`
            SELECT id, label, data FROM bread_kg_nodes
            WHERE agent_id = ${agentId} AND embedding IS NOT NULL
            ORDER BY embedding <=> ${vec(await embed(query))}::vector LIMIT ${n}`
        : await sql<Array<{ id: string; label: string; data: Record<string, unknown> }>>`
            SELECT id, label, data FROM bread_kg_nodes
            WHERE agent_id = ${agentId} AND label ILIKE ${`%${query}%`}
            ORDER BY created_at DESC LIMIT ${n}`
      return rows.map((r): KnowledgeNode => ({ id: r.id, label: r.label, data: r.data ?? {} }))
    },

    async forgetKnowledge({ id }) {
      const res = await sql`DELETE FROM bread_kg_nodes WHERE id = ${id}`
      return { deleted: res.count > 0 }
    },

    async knowledgeContext({ agentId, sessionId, limit }) {
      const rows = await sql<Array<{ label: string; data: Record<string, unknown> }>>`
        SELECT label, data FROM bread_kg_nodes
        WHERE agent_id = ${agentId} AND session_id = ${sessionId}
        ORDER BY created_at DESC LIMIT ${limit ?? 100}`
      return rows.map((r) => ({ label: r.label, data: r.data ?? {} }))
    },

    // --- Documents -----------------------------------------------------------
    async ingestDocument({ agentId, title, content, source }) {
      const id = uuidv7()
      const now = Date.now()
      if (embed) {
        const e = vec(await embed(content))
        await sql`INSERT INTO bread_documents (id, agent_id, title, content, source, embedding, created_at)
                  VALUES (${id}, ${agentId}, ${title}, ${content}, ${source ?? null}, ${e}::vector, ${now})`
      } else {
        await sql`INSERT INTO bread_documents (id, agent_id, title, content, source, created_at)
                  VALUES (${id}, ${agentId}, ${title}, ${content}, ${source ?? null}, ${now})`
      }
      return { id, title }
    },

    async searchDocuments({ agentId, query, limit }) {
      const n = limit ?? 5
      if (rerankRef) {
        const rows = embed
          ? await sql<Array<{ id: string; title: string; source: string | null; content: string }>>`
              SELECT id, title, source, content FROM bread_documents
              WHERE agent_id = ${agentId} AND embedding IS NOT NULL
              ORDER BY embedding <=> ${vec(await embed(query))}::vector`
          : await sql<Array<{ id: string; title: string; source: string | null; content: string }>>`
              SELECT id, title, source, content FROM bread_documents
              WHERE agent_id = ${agentId} AND (title ILIKE ${`%${query}%`} OR content ILIKE ${`%${query}%`})`
        const ordered = await rerankHits({
          query,
          hits: rows,
          text: (row) => row.content,
          ref: rerankRef,
          registry,
          limit: n,
        })
        return ordered.map((r): DocumentRecord => ({ id: r.id, title: r.title, source: r.source }))
      }
      const rows = embed
        ? await sql<Array<{ id: string; title: string; source: string | null }>>`
            SELECT id, title, source FROM bread_documents
            WHERE agent_id = ${agentId} AND embedding IS NOT NULL
            ORDER BY embedding <=> ${vec(await embed(query))}::vector LIMIT ${n}`
        : await sql<Array<{ id: string; title: string; source: string | null }>>`
            SELECT id, title, source FROM bread_documents
            WHERE agent_id = ${agentId} AND (title ILIKE ${`%${query}%`} OR content ILIKE ${`%${query}%`})
            LIMIT ${n}`
      return rows.map((r): DocumentRecord => ({ id: r.id, title: r.title, source: r.source }))
    },

    async readDocument({ agentId, id }) {
      const rows = await sql<Array<{ title: string; content: string }>>`
        SELECT title, content FROM bread_documents WHERE id = ${id} AND agent_id = ${agentId}`
      return rows[0] ? { title: rows[0].title, content: rows[0].content } : undefined
    },

    // --- Lifecycle -----------------------------------------------------------
    async migrate() {
      await migrate(sql, Boolean(embed))
    },

    async close() {
      await sql.end()
    },

    bindReranking(next) {
      if (next !== undefined) registry = next
    },
  }
}
