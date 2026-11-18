import {
  BreadError,
  migrationChecksum,
  redactConnectionSecrets,
  redactError,
  type MigrationJournal,
  type MigrationStep,
} from '@breadai/core'
import type postgres from 'postgres'

type Sql = ReturnType<typeof postgres>
type Reserved = Awaited<ReturnType<Sql['reserve']>>

export const BASELINE_ID = '0001_baseline'
export const VECTOR_ID = '0002_vector'

// Fixed advisory-lock key. Not derived from a request or a tool argument.
const LOCK_SQL = 'SELECT pg_try_advisory_lock(1651408997, 1835955305) AS locked'
const UNLOCK_SQL = 'SELECT pg_advisory_unlock(1651408997, 1835955305)'
const JOURNAL_SQL = `
CREATE TABLE IF NOT EXISTS bread_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at BIGINT NOT NULL
)`

// All tables are prefixed `bread_` so the store can share a database with an
// application's own schema without collisions. Timestamps are BIGINT epoch ms.
// `embedding` columns are pgvector and stay NULL unless an embedder is wired.
const TABLES = `
CREATE TABLE IF NOT EXISTS bread_sessions (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  agent_id TEXT,
  tags JSONB NOT NULL DEFAULT '{}',
  principal JSONB
);
CREATE TABLE IF NOT EXISTS bread_session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES bread_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content JSONB NOT NULL,
  timestamp BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bread_sm_session ON bread_session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_bread_s_updated ON bread_sessions(updated_at);

CREATE TABLE IF NOT EXISTS bread_checkpoints (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES bread_sessions(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  schema JSONB NOT NULL,
  prompt TEXT,
  skill TEXT,
  parent JSONB,
  pending JSONB,
  principal JSONB,
  claimed INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bread_loops (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pool JSONB NOT NULL,
  pipeline JSONB NOT NULL,
  max_iterations INTEGER NOT NULL,
  status TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 0,
  result JSONB,
  last_output JSONB,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_bread_loops_session ON bread_loops(session_id);
CREATE INDEX IF NOT EXISTS idx_bread_loops_agent ON bread_loops(agent_id);
CREATE TABLE IF NOT EXISTS bread_loop_iterations (
  id TEXT PRIMARY KEY,
  loop_id TEXT NOT NULL REFERENCES bread_loops(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  input JSONB,
  output JSONB,
  started_at BIGINT NOT NULL,
  completed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bread_loop_iter_loop ON bread_loop_iterations(loop_id);

-- Leftover bread_kg_* tables are not dropped. This migration does not read them.
CREATE TABLE IF NOT EXISTS bread_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  principal_iss TEXT NOT NULL,
  principal_sub TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bread_memories_owner ON bread_memories(agent_id, principal_iss, principal_sub);

CREATE TABLE IF NOT EXISTS bread_documents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bread_documents_agent ON bread_documents(agent_id);

CREATE TABLE IF NOT EXISTS bread_crumbs (
  run_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  session_id TEXT REFERENCES bread_sessions(id) ON DELETE CASCADE,
  agent_id TEXT,
  type TEXT NOT NULL,
  crumb JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_bread_crumbs_session ON bread_crumbs(session_id);

CREATE TABLE IF NOT EXISTS bread_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  run_id TEXT,
  model JSONB NOT NULL,
  input JSONB,
  output JSONB,
  status TEXT NOT NULL,
  usage JSONB,
  error TEXT,
  duration_ms INTEGER,
  created_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_bread_task_runs_task ON bread_task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_bread_task_runs_session ON bread_task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_bread_task_runs_agent ON bread_task_runs(agent_id);

-- Width of vectors already stored for a relation. Plain integers so a length
-- check can reject a later embedder before any ::vector cast.
CREATE TABLE IF NOT EXISTS bread_embedding_widths (
  relation TEXT PRIMARY KEY,
  width INTEGER NOT NULL
);
`

// Add the pgvector embedding columns. Run only when an embedder is configured;
// requires the `vector` extension (enabled here, needs a superuser/owner role).
const VECTOR = `
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE bread_memories ADD COLUMN IF NOT EXISTS embedding vector;
ALTER TABLE bread_documents ADD COLUMN IF NOT EXISTS embedding vector;
`

// Additive columns for tables that predate them — safe to re-run.
const COLUMNS = `
ALTER TABLE bread_checkpoints ADD COLUMN IF NOT EXISTS skill TEXT;
ALTER TABLE bread_checkpoints ADD COLUMN IF NOT EXISTS parent JSONB;
ALTER TABLE bread_checkpoints ADD COLUMN IF NOT EXISTS pending JSONB;
ALTER TABLE bread_checkpoints ADD COLUMN IF NOT EXISTS principal JSONB;
ALTER TABLE bread_checkpoints ADD COLUMN IF NOT EXISTS execution_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS bread_checkpoints_execution_idx ON bread_checkpoints(execution_id);
ALTER TABLE bread_sessions ADD COLUMN IF NOT EXISTS principal JSONB;
ALTER TABLE bread_checkpoints ADD COLUMN IF NOT EXISTS claimed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bread_loops ADD COLUMN IF NOT EXISTS last_output JSONB;
`

// TABLES then COLUMNS. VECTOR stays off this text so an unset embed does not
// hash or run the extension.
export const BASELINE_TEXT = `${TABLES}${COLUMNS}`
export const VECTOR_TEXT = VECTOR

const BASELINE_CHECKSUM = migrationChecksum(BASELINE_TEXT)
const VECTOR_CHECKSUM = migrationChecksum(VECTOR_TEXT)

function sqlState(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return undefined
}

function journalError(err: unknown): BreadError {
  if (err instanceof BreadError) {
    return new BreadError(redactConnectionSecrets(err.message), err.code, err.context, redactError(err.cause))
  }
  const state = sqlState(err)
  if (state === '42P01') {
    return new BreadError('Migration journal is missing.', 'MIGRATION_JOURNAL_MISSING', {}, redactError(err))
  }
  if (state === '42501') {
    return new BreadError('Migration journal could not be read.', 'MIGRATION_JOURNAL_FORBIDDEN', {}, redactError(err))
  }
  return new BreadError('Migration journal could not be read.', 'MIGRATION_FAILED', {}, redactError(err))
}

export function postgresMigration(sql: Sql, withVectors: boolean): {
  journal: MigrationJournal
  steps: MigrationStep[]
  knownIds: string[]
} {
  let pinned: Reserved | null = null
  const conn = (): Reserved => {
    if (!pinned) throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {})
    return pinned
  }

  const journal: MigrationJournal = {
    async lock() {
      let reserved: Reserved | null = null
      try {
        reserved = await sql.reserve()
        const rows = await reserved.unsafe<Array<{ locked: boolean }>>(LOCK_SQL)
        if (rows[0]?.locked !== true) {
          reserved.release()
          reserved = null
          throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {})
        }
      } catch (err) {
        if (reserved) {
          try {
            reserved.release()
          } catch {
            // The lock error is the one callers need.
          }
        }
        if (err instanceof BreadError && err.code === 'MIGRATION_LOCK') throw err
        throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {}, redactError(err))
      }
      pinned = reserved
      let released = false
      const release = async (): Promise<void> => {
        if (released || !reserved) return
        released = true
        try {
          await reserved.unsafe(UNLOCK_SQL)
        } finally {
          pinned = null
          reserved.release()
        }
      }
      return { commit: release, rollback: release }
    },

    async applied() {
      try {
        const db = conn()
        const rows = await db<Array<{ id: string; checksum: string }>>`
          SELECT id, checksum FROM bread_migrations ORDER BY id`
        return rows.map((row) => ({ id: row.id, checksum: row.checksum }))
      } catch (err) {
        throw journalError(err)
      }
    },

    async ensure() {
      try {
        await conn().unsafe(JOURNAL_SQL)
      } catch (err) {
        throw journalError(err)
      }
    },

    async record(id, checksum) {
      if (typeof id !== 'string' || typeof checksum !== 'string') {
        throw new BreadError('Migration step id is invalid.', 'MIGRATION_INVALID', {})
      }
      try {
        const db = conn()
        const rows = await db<Array<{ id: string }>>`
          INSERT INTO bread_migrations (id, checksum, applied_at)
          VALUES (${id}, ${checksum}, ${Date.now()})
          ON CONFLICT (id) DO NOTHING
          RETURNING id`
        return rows.length > 0
      } catch (err) {
        throw journalError(err)
      }
    },
  }

  const exec = async (text: string): Promise<void> => {
    await conn().unsafe(text)
  }
  const baseline: MigrationStep = {
    id: BASELINE_ID,
    checksum: BASELINE_CHECKSUM,
    up: () => exec(BASELINE_TEXT),
  }
  const vector: MigrationStep = {
    id: VECTOR_ID,
    checksum: VECTOR_CHECKSUM,
    up: () => exec(VECTOR_TEXT),
  }
  // Session lock on the reserved connection. Each step autocommits, so a failed
  // extension does not roll back the baseline.
  if (withVectors) return { journal, steps: [baseline, vector], knownIds: [] }
  return { journal, steps: [baseline], knownIds: [VECTOR_ID] }
}
