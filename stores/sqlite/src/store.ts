import { Database } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'
import type {
  BreadStore,
  CheckpointRecord,
  CleanupOptions,
  CrumbLogEntry,
  DocumentRecord,
  KnowledgeNode,
  LoopIteration,
  LoopRecord,
  LoopStatus,
  Session,
  SessionMessage,
  TaskRunRecord,
  TaskRunStatus,
} from '@bread/core'

export interface SqliteStoreOptions {
  // File path for persistence, or ':memory:' (default) for an ephemeral db.
  path?: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  agent_id TEXT,
  tags TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  schema TEXT NOT NULL,
  prompt TEXT,
  skill TEXT,
  parent TEXT,
  pending TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pool TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  max_iterations INTEGER NOT NULL,
  status TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_loops_session ON loops(session_id);
CREATE INDEX IF NOT EXISTS idx_loops_agent ON loops(agent_id);
CREATE TABLE IF NOT EXISTS loop_iterations (
  id TEXT PRIMARY KEY,
  loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  input TEXT,
  output TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loop_iter_loop ON loop_iterations(loop_id);

CREATE TABLE IF NOT EXISTS kg_nodes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  label TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kg_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_agent ON kg_nodes(agent_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_from ON kg_edges(from_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_agent ON documents(agent_id);

CREATE TABLE IF NOT EXISTS crumbs (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT,
  type TEXT NOT NULL,
  crumb TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_crumbs_session ON crumbs(session_id);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  run_id TEXT,
  model TEXT NOT NULL,
  input TEXT,
  output TEXT,
  status TEXT NOT NULL,
  usage TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_agent ON task_runs(agent_id);
`

interface SessionRow {
  id: string
  created_at: number
  updated_at: number
  agent_id: string | null
  tags: string
}

interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  timestamp: number
}

interface CheckpointRow {
  id: string
  agent_id: string
  run_id: string
  session_id: string
  tool_name: string
  tool_call_id: string
  schema: string
  prompt: string | null
  skill: string | null
  parent: string | null
  pending: string | null
  created_at: number
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags) as Record<string, string>,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
  }
}

function rowToMessage(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as SessionMessage['role'],
    content: JSON.parse(row.content) as unknown,
    timestamp: row.timestamp,
  }
}

function rowToCheckpoint(r: CheckpointRow): CheckpointRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    runId: r.run_id,
    sessionId: r.session_id,
    toolName: r.tool_name,
    toolCallId: r.tool_call_id,
    schema: JSON.parse(r.schema) as unknown,
    ...(r.prompt != null ? { prompt: r.prompt } : {}),
    ...(r.skill != null ? { skill: r.skill } : {}),
    ...(r.parent != null ? { parent: JSON.parse(r.parent) as CheckpointRecord['parent'] } : {}),
    ...(r.pending != null ? { pending: JSON.parse(r.pending) as CheckpointRecord['pending'] } : {}),
    createdAt: r.created_at,
  }
}

interface LoopRow {
  id: string
  agent_id: string
  session_id: string
  run_id: string
  pool: string
  pipeline: string
  max_iterations: number
  status: string
  iterations: number
  result: string | null
  started_at: number
  completed_at: number | null
}

interface LoopIterationRow {
  id: string
  loop_id: string
  idx: number
  input: string | null
  output: string | null
  started_at: number
  completed_at: number
}

function rowToLoop(r: LoopRow): LoopRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    sessionId: r.session_id,
    runId: r.run_id,
    pool: JSON.parse(r.pool) as string[],
    pipeline: JSON.parse(r.pipeline) as string[],
    maxIterations: r.max_iterations,
    status: r.status as LoopStatus,
    iterations: r.iterations,
    ...(r.result != null ? { result: JSON.parse(r.result) as unknown } : {}),
    startedAt: r.started_at,
    ...(r.completed_at != null ? { completedAt: r.completed_at } : {}),
  }
}

function rowToLoopIteration(r: LoopIterationRow): LoopIteration {
  return {
    id: r.id,
    loopId: r.loop_id,
    index: r.idx,
    input: r.input != null ? (JSON.parse(r.input) as unknown) : null,
    output: r.output != null ? (JSON.parse(r.output) as unknown) : null,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  }
}

interface TaskRunRow {
  id: string
  task_id: string
  agent_id: string | null
  session_id: string | null
  run_id: string | null
  model: string
  input: string | null
  output: string | null
  status: string
  usage: string | null
  error: string | null
  duration_ms: number | null
  created_at: number
  completed_at: number | null
}

function rowToTaskRun(r: TaskRunRow): TaskRunRecord {
  return {
    id: r.id,
    taskId: r.task_id,
    ...(r.agent_id != null ? { agentId: r.agent_id } : {}),
    ...(r.session_id != null ? { sessionId: r.session_id } : {}),
    ...(r.run_id != null ? { runId: r.run_id } : {}),
    model: JSON.parse(r.model) as { provider: string; model: string },
    input: r.input != null ? (JSON.parse(r.input) as unknown) : null,
    ...(r.output != null ? { output: JSON.parse(r.output) as unknown } : {}),
    status: r.status as TaskRunStatus,
    ...(r.usage != null ? { usage: JSON.parse(r.usage) as TaskRunRecord['usage'] } : {}),
    ...(r.error != null ? { error: r.error } : {}),
    ...(r.duration_ms != null ? { durationMs: r.duration_ms } : {}),
    createdAt: r.created_at,
    ...(r.completed_at != null ? { completedAt: r.completed_at } : {}),
  }
}

interface CrumbRow {
  run_id: string
  seq: number
  session_id: string | null
  agent_id: string | null
  type: string
  crumb: string
  created_at: number
}

function rowToCrumbEntry(r: CrumbRow): CrumbLogEntry {
  return {
    runId: r.run_id,
    seq: r.seq,
    ...(r.session_id != null ? { sessionId: r.session_id } : {}),
    ...(r.agent_id != null ? { agentId: r.agent_id } : {}),
    type: r.type,
    crumb: JSON.parse(r.crumb) as unknown,
    createdAt: r.created_at,
  }
}

// A SQLite BreadStore over Bun's built-in driver. Bun-only — uses bun:sqlite,
// not a native addon. A file path persists; ':memory:' (default) is ephemeral.
export function store(opts: SqliteStoreOptions = {}): BreadStore {
  const db = new Database(opts.path ?? ':memory:')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  // Additive column for tables that predate it — SQLite has no ADD COLUMN IF
  // NOT EXISTS, so guard with a duplicate-column catch instead.
  for (const column of ['skill TEXT', 'parent TEXT', 'pending TEXT']) {
    try {
      db.exec(`ALTER TABLE checkpoints ADD COLUMN ${column}`)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('duplicate column name')) throw err
    }
  }

  function matchTags(tags: Record<string, string>, filter?: Record<string, string>): boolean {
    if (!filter) return true
    return Object.entries(filter).every(([k, v]) => tags[k] === v)
  }

  return {
    // --- Sessions ------------------------------------------------------------
    async createSession(opts) {
      const id = opts?.id ?? uuidv7()
      const now = Date.now()
      db.prepare('INSERT INTO sessions (id, created_at, updated_at, tags) VALUES (?, ?, ?, ?)').run(
        id,
        now,
        now,
        JSON.stringify(opts?.tags ?? {}),
      )
      return { id, createdAt: now, updatedAt: now, tags: opts?.tags ?? {} }
    },

    async getSession(id) {
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
      return row ? rowToSession(row) : undefined
    },

    async listSessions(filter) {
      const rows = db.prepare('SELECT * FROM sessions').all() as SessionRow[]
      const sessions = rows.map(rowToSession)
      return filter?.tags ? sessions.filter((s) => matchTags(s.tags, filter.tags)) : sessions
    },

    async deleteSession(id) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    },

    async cleanupSessions(opts?: CleanupOptions) {
      const now = Date.now()
      const all = db.prepare('SELECT * FROM sessions').all() as SessionRow[]
      const del = db.prepare('DELETE FROM sessions WHERE id = ?')
      let count = 0
      const tx = db.transaction(() => {
        for (const row of all) {
          const session = rowToSession(row)
          const tooOld = opts?.olderThanMs ? now - session.updatedAt > opts.olderThanMs : false
          if (tooOld && matchTags(session.tags, opts?.tags)) {
            del.run(row.id)
            count++
          }
        }
      })
      tx()
      return count
    },

    async getMessages(sessionId) {
      const rows = db
        .prepare('SELECT * FROM session_messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC')
        .all(sessionId) as MessageRow[]
      return rows.map(rowToMessage)
    },

    async addMessage(sessionId, message) {
      const now = message.timestamp ?? Date.now()
      // v7: sortable, monotonic id so the turn's messages keep order under the
      // (timestamp, id) sort even when written within the same millisecond.
      db.prepare(
        'INSERT INTO session_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
      ).run(uuidv7(), sessionId, message.role, JSON.stringify(message.content), now)
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
    },

    // --- Checkpoints ---------------------------------------------------------
    async saveCheckpoint(record) {
      db.prepare(
        `INSERT OR REPLACE INTO checkpoints
         (id, agent_id, run_id, session_id, tool_name, tool_call_id, schema, prompt, skill, parent, pending, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.agentId,
        record.runId,
        record.sessionId,
        record.toolName,
        record.toolCallId,
        JSON.stringify(record.schema ?? null),
        record.prompt ?? null,
        record.skill ?? null,
        record.parent != null ? JSON.stringify(record.parent) : null,
        record.pending != null ? JSON.stringify(record.pending) : null,
        record.createdAt,
      )
    },

    async getCheckpoint(id) {
      const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as
        | CheckpointRow
        | undefined
      return row ? rowToCheckpoint(row) : undefined
    },

    async deleteCheckpoint(id) {
      const row = db.prepare('DELETE FROM checkpoints WHERE id = ? RETURNING *').get(id) as
        | CheckpointRow
        | undefined
      return row ? rowToCheckpoint(row) : undefined
    },

    async listCheckpoints() {
      const rows = db.prepare('SELECT * FROM checkpoints ORDER BY created_at ASC').all() as CheckpointRow[]
      return rows.map(rowToCheckpoint)
    },

    async suspendRun(sessionId, msgs, checkpoint) {
      const tx = db.transaction(() => {
        let last = checkpoint.createdAt
        for (const m of msgs) {
          const now = m.timestamp ?? Date.now()
          db.prepare(
            'INSERT INTO session_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
          ).run(uuidv7(), sessionId, m.role, JSON.stringify(m.content), now)
          last = now
        }
        db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(last, sessionId)
        db.prepare(
          `INSERT OR REPLACE INTO checkpoints
           (id, agent_id, run_id, session_id, tool_name, tool_call_id, schema, prompt, skill, parent, pending, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          checkpoint.id,
          checkpoint.agentId,
          checkpoint.runId,
          checkpoint.sessionId,
          checkpoint.toolName,
          checkpoint.toolCallId,
          JSON.stringify(checkpoint.schema ?? null),
          checkpoint.prompt ?? null,
          checkpoint.skill ?? null,
          checkpoint.parent != null ? JSON.stringify(checkpoint.parent) : null,
          checkpoint.pending != null ? JSON.stringify(checkpoint.pending) : null,
          checkpoint.createdAt,
        )
      })
      tx()
    },

    // --- Loops ---------------------------------------------------------------
    async createLoop(r) {
      db.prepare(
        `INSERT INTO loops
         (id, agent_id, session_id, run_id, pool, pipeline, max_iterations, status, iterations, result, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        r.id,
        r.agentId,
        r.sessionId,
        r.runId,
        JSON.stringify(r.pool),
        JSON.stringify(r.pipeline),
        r.maxIterations,
        r.status,
        r.iterations,
        r.result === undefined ? null : JSON.stringify(r.result),
        r.startedAt,
        r.completedAt ?? null,
      )
    },

    async updateLoop(id, patch) {
      if (patch.status !== undefined)
        db.prepare('UPDATE loops SET status = ? WHERE id = ?').run(patch.status, id)
      if (patch.iterations !== undefined)
        db.prepare('UPDATE loops SET iterations = ? WHERE id = ?').run(patch.iterations, id)
      if (patch.result !== undefined)
        db.prepare('UPDATE loops SET result = ? WHERE id = ?').run(JSON.stringify(patch.result), id)
      if (patch.completedAt !== undefined)
        db.prepare('UPDATE loops SET completed_at = ? WHERE id = ?').run(patch.completedAt, id)
    },

    async addLoopIteration(it) {
      db.prepare(
        `INSERT INTO loop_iterations (id, loop_id, idx, input, output, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        it.id,
        it.loopId,
        it.index,
        it.input === undefined ? null : JSON.stringify(it.input),
        it.output === undefined ? null : JSON.stringify(it.output),
        it.startedAt,
        it.completedAt,
      )
    },

    async getLoop(id) {
      const row = db.prepare('SELECT * FROM loops WHERE id = ?').get(id) as LoopRow | undefined
      if (!row) return undefined
      const iters = db
        .prepare('SELECT * FROM loop_iterations WHERE loop_id = ? ORDER BY idx ASC')
        .all(id) as LoopIterationRow[]
      return { loop: rowToLoop(row), iterations: iters.map(rowToLoopIteration) }
    },

    async listLoops(filter) {
      const rows = db.prepare('SELECT * FROM loops ORDER BY started_at DESC').all() as LoopRow[]
      let loops = rows.map(rowToLoop)
      if (filter?.sessionId) loops = loops.filter((l) => l.sessionId === filter.sessionId)
      if (filter?.agentId) loops = loops.filter((l) => l.agentId === filter.agentId)
      if (filter?.status) loops = loops.filter((l) => l.status === filter.status)
      return loops
    },

    // --- Task runs (audit) ---------------------------------------------------
    async createTaskRun(r) {
      db.prepare(
        `INSERT INTO task_runs
         (id, task_id, agent_id, session_id, run_id, model, input, output, status, usage, error, duration_ms, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        r.id,
        r.taskId,
        r.agentId ?? null,
        r.sessionId ?? null,
        r.runId ?? null,
        JSON.stringify(r.model),
        r.input === undefined ? null : JSON.stringify(r.input),
        r.output === undefined ? null : JSON.stringify(r.output),
        r.status,
        r.usage === undefined ? null : JSON.stringify(r.usage),
        r.error ?? null,
        r.durationMs ?? null,
        r.createdAt,
        r.completedAt ?? null,
      )
    },

    async finishTaskRun(id, patch) {
      if (patch.status !== undefined)
        db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run(patch.status, id)
      if (patch.output !== undefined)
        db.prepare('UPDATE task_runs SET output = ? WHERE id = ?').run(JSON.stringify(patch.output), id)
      if (patch.usage !== undefined)
        db.prepare('UPDATE task_runs SET usage = ? WHERE id = ?').run(JSON.stringify(patch.usage), id)
      if (patch.error !== undefined)
        db.prepare('UPDATE task_runs SET error = ? WHERE id = ?').run(patch.error, id)
      if (patch.durationMs !== undefined)
        db.prepare('UPDATE task_runs SET duration_ms = ? WHERE id = ?').run(patch.durationMs, id)
      if (patch.completedAt !== undefined)
        db.prepare('UPDATE task_runs SET completed_at = ? WHERE id = ?').run(patch.completedAt, id)
    },

    async getTaskRun(id) {
      const row = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as TaskRunRow | undefined
      return row ? rowToTaskRun(row) : undefined
    },

    async listTaskRuns(filter) {
      const rows = db
        .prepare('SELECT * FROM task_runs ORDER BY created_at DESC')
        .all() as TaskRunRow[]
      let runs = rows.map(rowToTaskRun)
      if (filter?.taskId) runs = runs.filter((r) => r.taskId === filter.taskId)
      if (filter?.agentId) runs = runs.filter((r) => r.agentId === filter.agentId)
      if (filter?.sessionId) runs = runs.filter((r) => r.sessionId === filter.sessionId)
      if (filter?.status) runs = runs.filter((r) => r.status === filter.status)
      if (filter?.limit) runs = runs.slice(0, filter.limit)
      return runs
    },

    // --- Crumb run-log ---------------------------------------------------------
    async appendCrumbs(entries) {
      const insert = db.prepare(
        `INSERT INTO crumbs (run_id, seq, session_id, agent_id, type, crumb, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      const tx = db.transaction(() => {
        for (const e of entries) {
          insert.run(
            e.runId,
            e.seq,
            e.sessionId ?? null,
            e.agentId ?? null,
            e.type,
            JSON.stringify(e.crumb),
            e.createdAt,
          )
        }
      })
      tx()
    },

    async getCrumbs(runId, opts) {
      const rows = db
        .prepare(
          `SELECT * FROM crumbs WHERE run_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(runId, opts?.afterSeq ?? 0, opts?.limit ?? -1) as CrumbRow[]
      return rows.map(rowToCrumbEntry)
    },

    async getMaxCrumbSeq(runId) {
      const row = db.prepare('SELECT MAX(seq) AS max FROM crumbs WHERE run_id = ?').get(runId) as
        | { max: number | null }
        | undefined
      return row?.max ?? 0
    },

    // --- Knowledge graph -----------------------------------------------------
    async addKnowledgeNode({ agentId, sessionId, label, data }) {
      const id = uuidv7()
      db.prepare(
        'INSERT INTO kg_nodes (id, agent_id, session_id, label, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, agentId, sessionId, label, JSON.stringify(data ?? {}), Date.now())
      return { id, label }
    },

    async addKnowledgeEdge({ fromId, toId, relation }) {
      db.prepare('INSERT INTO kg_edges (id, from_id, to_id, relation) VALUES (?, ?, ?, ?)').run(
        uuidv7(),
        fromId,
        toId,
        relation,
      )
    },

    async queryKnowledge({ agentId, query, limit }) {
      const rows = db
        .prepare(
          `SELECT id, label, data FROM kg_nodes
           WHERE agent_id = ? AND label LIKE ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(agentId, `%${query}%`, limit ?? 10) as Array<{ id: string; label: string; data: string }>
      return rows.map(
        (r): KnowledgeNode => ({
          id: r.id,
          label: r.label,
          data: JSON.parse(r.data) as Record<string, unknown>,
        }),
      )
    },

    async forgetKnowledge({ id }) {
      const info = db.prepare('DELETE FROM kg_nodes WHERE id = ?').run(id)
      return { deleted: info.changes > 0 }
    },

    async knowledgeContext({ agentId, sessionId, limit }) {
      const rows = db
        .prepare(
          `SELECT label, data FROM kg_nodes
           WHERE agent_id = ? AND session_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(agentId, sessionId, limit ?? 100) as Array<{ label: string; data: string }>
      return rows.map((r) => ({
        label: r.label,
        data: JSON.parse(r.data) as Record<string, unknown>,
      }))
    },

    // --- Documents -----------------------------------------------------------
    async ingestDocument({ agentId, title, content, source }) {
      const id = uuidv7()
      db.prepare(
        'INSERT INTO documents (id, agent_id, title, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, agentId, title, content, source ?? null, Date.now())
      return { id, title }
    },

    async searchDocuments({ agentId, query, limit }) {
      const rows = db
        .prepare(
          `SELECT id, title, source FROM documents
           WHERE agent_id = ? AND (title LIKE ? OR content LIKE ?)
           LIMIT ?`,
        )
        .all(agentId, `%${query}%`, `%${query}%`, limit ?? 5) as Array<{
        id: string
        title: string
        source: string | null
      }>
      return rows.map((r): DocumentRecord => ({ id: r.id, title: r.title, source: r.source }))
    },

    async readDocument({ agentId, id }) {
      const row = db
        .prepare('SELECT title, content FROM documents WHERE id = ? AND agent_id = ?')
        .get(id, agentId) as { title: string; content: string } | undefined
      return row ? { title: row.title, content: row.content } : undefined
    },

    // --- Lifecycle -----------------------------------------------------------
    async close() {
      db.close()
    },
  }
}
