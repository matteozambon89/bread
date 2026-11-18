import { Database } from 'bun:sqlite'
import {
  BreadError,
  migrationChecksum,
  redactError,
  type MigrationJournal,
  type MigrationStep,
} from '@breadai/core'

export const BASELINE_ID = '0001_baseline'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  agent_id TEXT,
  tags TEXT NOT NULL DEFAULT '{}',
  principal TEXT
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
  execution_id TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  schema TEXT NOT NULL,
  prompt TEXT,
  skill TEXT,
  parent TEXT,
  pending TEXT,
  principal TEXT,
  claimed INTEGER NOT NULL DEFAULT 0,
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
  last_output TEXT,
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

-- Leftover kg_nodes and kg_edges are not dropped. This schema does not read them.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  principal_iss TEXT NOT NULL,
  principal_sub TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(agent_id, principal_iss, principal_sub);

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

const EXECUTION_INDEX = 'CREATE INDEX IF NOT EXISTS idx_checkpoints_execution ON checkpoints(execution_id)'

const GUARDS = [
  { table: 'checkpoints', column: 'skill', sql: 'ALTER TABLE checkpoints ADD COLUMN skill TEXT' },
  { table: 'checkpoints', column: 'parent', sql: 'ALTER TABLE checkpoints ADD COLUMN parent TEXT' },
  { table: 'checkpoints', column: 'pending', sql: 'ALTER TABLE checkpoints ADD COLUMN pending TEXT' },
  { table: 'checkpoints', column: 'principal', sql: 'ALTER TABLE checkpoints ADD COLUMN principal TEXT' },
  { table: 'checkpoints', column: 'claimed', sql: 'ALTER TABLE checkpoints ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0' },
  { table: 'checkpoints', column: 'execution_id', sql: "ALTER TABLE checkpoints ADD COLUMN execution_id TEXT NOT NULL DEFAULT ''" },
  { table: 'sessions', column: 'principal', sql: 'ALTER TABLE sessions ADD COLUMN principal TEXT' },
  { table: 'loops', column: 'last_output', sql: 'ALTER TABLE loops ADD COLUMN last_output TEXT' },
] as const

const JOURNAL_SQL = `CREATE TABLE IF NOT EXISTS bread_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`

export const BASELINE_TEXT = [SCHEMA.trim(), ...GUARDS.map((guard) => guard.sql), EXECUTION_INDEX].join('\n')
const BASELINE_CHECKSUM = migrationChecksum(BASELINE_TEXT)

function sqlCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code)
  return ''
}

function isUnique(err: unknown): boolean {
  const code = sqlCode(err)
  const message = err instanceof Error ? err.message : ''
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE constraint failed')
}

function isBusy(err: unknown): boolean {
  const code = sqlCode(err)
  const message = err instanceof Error ? err.message : ''
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|SQLITE_BUSY/i.test(message)
}

function isForbidden(err: unknown): boolean {
  const code = sqlCode(err)
  const message = err instanceof Error ? err.message : ''
  return code === 'SQLITE_PERM' || code === 'SQLITE_READONLY' || code === 'SQLITE_AUTH' || /readonly database|permission denied/i.test(message)
}

function sqliteError(err: unknown, fallback: string, code: string): BreadError {
  if (err instanceof BreadError) return err
  if (isForbidden(err)) {
    return new BreadError('Migration journal could not be read.', 'MIGRATION_JOURNAL_FORBIDDEN', {}, redactError(err))
  }
  if (isBusy(err)) {
    return new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {}, redactError(err))
  }
  if (err instanceof Error && /no such table/i.test(err.message)) {
    return new BreadError('Migration journal is missing.', 'MIGRATION_JOURNAL_MISSING', {}, redactError(err))
  }
  return new BreadError(fallback, code, {}, redactError(err))
}

function columns(db: Database, table: 'checkpoints' | 'sessions' | 'loops'): Set<string> {
  const pragma =
    table === 'checkpoints'
      ? 'PRAGMA table_info(checkpoints)'
      : table === 'sessions'
        ? 'PRAGMA table_info(sessions)'
        : 'PRAGMA table_info(loops)'
  const rows = db.prepare(pragma).all() as { name: string }[]
  return new Set(rows.map((row) => row.name))
}

export function sqliteMigration(db: Database): {
  journal: MigrationJournal
  steps: MigrationStep[]
  knownIds: string[]
} {
  const journal: MigrationJournal = {
    async lock() {
      // BEGIN IMMEDIATE is the file lock. Timeout stays the process default.
      try {
        db.exec('BEGIN IMMEDIATE')
      } catch (err) {
        throw sqliteError(err, 'Could not acquire the migration lock.', 'MIGRATION_LOCK')
      }
      let released = false
      const end = (statement: 'COMMIT' | 'ROLLBACK') => {
        if (released) return
        db.exec(statement)
        released = true
      }
      return {
        commit: async () => end('COMMIT'),
        rollback: async () => end('ROLLBACK'),
      }
    },

    async applied() {
      try {
        const row = db
          .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('bread_migrations') as { ok: number } | null
        if (!row) throw new BreadError('Migration journal is missing.', 'MIGRATION_JOURNAL_MISSING', {})
        const rows = db.prepare('SELECT id, checksum FROM bread_migrations ORDER BY id').all() as {
          id: string
          checksum: string
        }[]
        return rows.map((entry) => ({ id: entry.id, checksum: entry.checksum }))
      } catch (err) {
        if (err instanceof BreadError) throw err
        throw sqliteError(err, 'Migration journal could not be read.', 'MIGRATION_FAILED')
      }
    },

    async ensure() {
      try {
        db.exec(JOURNAL_SQL)
      } catch (err) {
        throw sqliteError(err, 'Migration journal could not be created.', 'MIGRATION_FAILED')
      }
    },

    async record(id, checksum) {
      if (typeof id !== 'string' || typeof checksum !== 'string') {
        throw new BreadError('Migration step id is invalid.', 'MIGRATION_INVALID', {})
      }
      try {
        db.prepare('INSERT INTO bread_migrations (id, checksum, applied_at) VALUES (?, ?, ?)').run(id, checksum, Date.now())
        return true
      } catch (err) {
        if (isUnique(err)) return false
        throw sqliteError(err, 'Migration journal could not be written.', 'MIGRATION_FAILED')
      }
    },
  }

  const steps: MigrationStep[] = [
    {
      id: BASELINE_ID,
      checksum: BASELINE_CHECKSUM,
      up: async () => {
        db.exec(SCHEMA)
        for (const guard of GUARDS) {
          if (columns(db, guard.table).has(guard.column)) continue
          db.exec(guard.sql)
        }
        db.exec(EXECUTION_INDEX)
      },
    },
  ]
  return { journal, steps, knownIds: [] }
}
