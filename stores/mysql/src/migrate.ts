import type { Pool, RowDataPacket } from 'mysql2/promise'
import {
  BreadError,
  migrationChecksum,
  redactError,
  type MigrationJournal,
  type MigrationStep,
} from '@breadai/core'
import { errno, execStatic, executeSql, selectRows, sqlCode, type Sql } from './db.js'

export const BASELINE_ID = '0001_baseline'
export const MIGRATION_LOCK_NAME = 'bread_mysql_schema'

const JOURNAL_SQL = `CREATE TABLE IF NOT EXISTS bread_migrations (
  id VARCHAR(64) NOT NULL,
  checksum CHAR(64) NOT NULL,
  applied_at BIGINT NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`

const ENGINE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'

// Leftover bread_kg_* tables are not dropped. This migration does not read them.
const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS bread_sessions (
  id VARCHAR(128) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  agent_id VARCHAR(128) NULL,
  tags JSON NOT NULL,
  principal JSON NULL,
  PRIMARY KEY (id)
) ${ENGINE}`,
  `CREATE TABLE IF NOT EXISTS bread_session_messages (
  id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  role VARCHAR(32) NOT NULL,
  content JSON NOT NULL,
  timestamp BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_bread_sm_session FOREIGN KEY (session_id) REFERENCES bread_sessions (id) ON DELETE CASCADE
) ${ENGINE}`,
  `CREATE TABLE IF NOT EXISTS bread_checkpoints (
  id VARCHAR(128) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  run_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  execution_id VARCHAR(128) NOT NULL DEFAULT '',
  tool_name VARCHAR(255) NOT NULL,
  tool_call_id VARCHAR(255) NOT NULL,
  \`schema\` JSON NOT NULL,
  prompt TEXT NULL,
  skill VARCHAR(255) NULL,
  parent JSON NULL,
  pending JSON NULL,
  principal JSON NULL,
  claimed TINYINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_bread_cp_session FOREIGN KEY (session_id) REFERENCES bread_sessions (id) ON DELETE CASCADE
) ${ENGINE}`,
  `CREATE TABLE IF NOT EXISTS bread_loops (
  id VARCHAR(128) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  run_id VARCHAR(128) NOT NULL,
  pool JSON NOT NULL,
  pipeline JSON NOT NULL,
  max_iterations INT NOT NULL,
  status VARCHAR(32) NOT NULL,
  iterations INT NOT NULL DEFAULT 0,
  result JSON NULL,
  last_output JSON NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT NULL,
  PRIMARY KEY (id)
) ${ENGINE}`,
  `CREATE TABLE IF NOT EXISTS bread_loop_iterations (
  id VARCHAR(128) NOT NULL,
  loop_id VARCHAR(128) NOT NULL,
  idx INT NOT NULL,
  input JSON NULL,
  output JSON NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_bread_loop_iter FOREIGN KEY (loop_id) REFERENCES bread_loops (id) ON DELETE CASCADE
) ${ENGINE}`,
  `CREATE TABLE IF NOT EXISTS bread_memories (
  id VARCHAR(128) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  principal_iss VARCHAR(255) NOT NULL,
  principal_sub VARCHAR(255) NOT NULL,
  content LONGTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
) ${ENGINE}`,
  `CREATE TABLE IF NOT EXISTS bread_documents (
  id VARCHAR(128) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  title TEXT NOT NULL,
  content LONGTEXT NOT NULL,
  source TEXT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
) ${ENGINE}`,
  `CREATE TABLE IF NOT EXISTS bread_crumbs (
  run_id VARCHAR(128) NOT NULL,
  seq BIGINT NOT NULL,
  session_id VARCHAR(128) NULL,
  agent_id VARCHAR(128) NULL,
  type VARCHAR(64) NOT NULL,
  crumb JSON NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (run_id, seq),
  CONSTRAINT fk_bread_crumbs_session FOREIGN KEY (session_id) REFERENCES bread_sessions (id) ON DELETE CASCADE
) ${ENGINE}`,
  `CREATE TABLE IF NOT EXISTS bread_task_runs (
  id VARCHAR(128) NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  agent_id VARCHAR(128) NULL,
  session_id VARCHAR(128) NULL,
  run_id VARCHAR(128) NULL,
  model JSON NOT NULL,
  input JSON NULL,
  output JSON NULL,
  status VARCHAR(32) NOT NULL,
  \`usage\` JSON NULL,
  error TEXT NULL,
  duration_ms INT NULL,
  created_at BIGINT NOT NULL,
  completed_at BIGINT NULL,
  PRIMARY KEY (id)
) ${ENGINE}`,
] as const

const GUARDS = [
  { table: 'bread_checkpoints', column: 'skill', sql: 'ALTER TABLE bread_checkpoints ADD COLUMN skill VARCHAR(255) NULL' },
  { table: 'bread_checkpoints', column: 'parent', sql: 'ALTER TABLE bread_checkpoints ADD COLUMN parent JSON NULL' },
  { table: 'bread_checkpoints', column: 'pending', sql: 'ALTER TABLE bread_checkpoints ADD COLUMN pending JSON NULL' },
  { table: 'bread_checkpoints', column: 'principal', sql: 'ALTER TABLE bread_checkpoints ADD COLUMN principal JSON NULL' },
  { table: 'bread_checkpoints', column: 'claimed', sql: 'ALTER TABLE bread_checkpoints ADD COLUMN claimed TINYINT NOT NULL DEFAULT 0' },
  {
    table: 'bread_checkpoints',
    column: 'execution_id',
    sql: "ALTER TABLE bread_checkpoints ADD COLUMN execution_id VARCHAR(128) NOT NULL DEFAULT ''",
  },
  { table: 'bread_sessions', column: 'principal', sql: 'ALTER TABLE bread_sessions ADD COLUMN principal JSON NULL' },
  { table: 'bread_loops', column: 'last_output', sql: 'ALTER TABLE bread_loops ADD COLUMN last_output JSON NULL' },
] as const

const INDEXES = [
  {
    table: 'bread_session_messages',
    name: 'idx_bread_sm_session',
    sql: 'CREATE INDEX idx_bread_sm_session ON bread_session_messages (session_id)',
  },
  {
    table: 'bread_sessions',
    name: 'idx_bread_s_updated',
    sql: 'CREATE INDEX idx_bread_s_updated ON bread_sessions (updated_at)',
  },
  {
    table: 'bread_checkpoints',
    name: 'idx_bread_checkpoints_execution',
    sql: 'CREATE INDEX idx_bread_checkpoints_execution ON bread_checkpoints (execution_id)',
  },
  {
    table: 'bread_loops',
    name: 'idx_bread_loops_session',
    sql: 'CREATE INDEX idx_bread_loops_session ON bread_loops (session_id)',
  },
  {
    table: 'bread_loops',
    name: 'idx_bread_loops_agent',
    sql: 'CREATE INDEX idx_bread_loops_agent ON bread_loops (agent_id)',
  },
  {
    table: 'bread_loop_iterations',
    name: 'idx_bread_loop_iter_loop',
    sql: 'CREATE INDEX idx_bread_loop_iter_loop ON bread_loop_iterations (loop_id)',
  },
  {
    table: 'bread_memories',
    name: 'idx_bread_memories_owner',
    sql: 'CREATE INDEX idx_bread_memories_owner ON bread_memories (agent_id, principal_iss, principal_sub)',
  },
  {
    table: 'bread_documents',
    name: 'idx_bread_documents_agent',
    sql: 'CREATE INDEX idx_bread_documents_agent ON bread_documents (agent_id)',
  },
  {
    table: 'bread_crumbs',
    name: 'idx_bread_crumbs_session',
    sql: 'CREATE INDEX idx_bread_crumbs_session ON bread_crumbs (session_id)',
  },
  {
    table: 'bread_task_runs',
    name: 'idx_bread_task_runs_task',
    sql: 'CREATE INDEX idx_bread_task_runs_task ON bread_task_runs (task_id)',
  },
  {
    table: 'bread_task_runs',
    name: 'idx_bread_task_runs_session',
    sql: 'CREATE INDEX idx_bread_task_runs_session ON bread_task_runs (session_id)',
  },
  {
    table: 'bread_task_runs',
    name: 'idx_bread_task_runs_agent',
    sql: 'CREATE INDEX idx_bread_task_runs_agent ON bread_task_runs (agent_id)',
  },
] as const

export const BASELINE_TEXT = [
  ...CREATE_STATEMENTS,
  ...GUARDS.map((guard) => guard.sql),
  ...INDEXES.map((index) => index.sql),
].join('\n')

const BASELINE_CHECKSUM = migrationChecksum(BASELINE_TEXT)

const FORBIDDEN = new Set([1044, 1045, 1142, 1227, 1370])

function isForbidden(err: unknown): boolean {
  const number = errno(err)
  if (number !== undefined && FORBIDDEN.has(number)) return true
  const code = sqlCode(err)
  return (
    code === 'ER_TABLEACCESS_DENIED_ERROR' ||
    code === 'ER_DBACCESS_DENIED_ERROR' ||
    code === 'ER_ACCESS_DENIED_ERROR' ||
    code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR'
  )
}

function isMissing(err: unknown): boolean {
  return errno(err) === 1146 || sqlCode(err) === 'ER_NO_SUCH_TABLE'
}

function isDuplicate(err: unknown): boolean {
  return errno(err) === 1062 || sqlCode(err) === 'ER_DUP_ENTRY'
}

function journalError(err: unknown, fallback: string, code: string): BreadError {
  if (err instanceof BreadError) {
    return new BreadError(err.message, err.code, err.context, redactError(err.cause))
  }
  if (isForbidden(err)) {
    return new BreadError('Migration journal could not be read.', 'MIGRATION_JOURNAL_FORBIDDEN', {}, redactError(err))
  }
  if (isMissing(err)) {
    return new BreadError('Migration journal is missing.', 'MIGRATION_JOURNAL_MISSING', {}, redactError(err))
  }
  return new BreadError(fallback, code, {}, redactError(err))
}

async function hasColumn(conn: Sql, table: string, column: string): Promise<boolean> {
  const rows = await selectRows<RowDataPacket>(
    conn,
    `SELECT 1 AS ok FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )
  return rows.length > 0
}

async function hasIndex(conn: Sql, table: string, name: string): Promise<boolean> {
  const rows = await selectRows<RowDataPacket>(
    conn,
    `SELECT 1 AS ok FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  )
  return rows.length > 0
}

export function mysqlMigration(pool: Pool): {
  journal: MigrationJournal
  steps: MigrationStep[]
  knownIds: string[]
} {
  let pinned: Sql | null = null
  const conn = (): Sql => {
    if (!pinned) throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {})
    return pinned
  }

  const journal: MigrationJournal = {
    async lock() {
      let reserved: Awaited<ReturnType<Pool['getConnection']>>
      try {
        reserved = await pool.getConnection()
      } catch (err) {
        throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {}, redactError(err))
      }
      let acquired = false
      try {
        const rows = await selectRows<RowDataPacket>(reserved, 'SELECT GET_LOCK(?, 0) AS locked', [MIGRATION_LOCK_NAME])
        acquired = Number(rows[0]?.locked) === 1
        if (!acquired) throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {})
      } catch (err) {
        try {
          reserved.release()
        } catch {
          // The lock error is the one callers need.
        }
        if (err instanceof BreadError && err.code === 'MIGRATION_LOCK') throw err
        throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {}, redactError(err))
      }
      pinned = reserved
      let released = false
      const release = async (): Promise<void> => {
        if (released) return
        released = true
        try {
          await executeSql(reserved, 'SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK_NAME])
        } finally {
          pinned = null
          reserved.release()
        }
      }
      return { commit: release, rollback: release }
    },

    async applied() {
      try {
        const rows = await selectRows<RowDataPacket>(
          conn(),
          'SELECT id, checksum FROM bread_migrations ORDER BY id',
        )
        return rows.map((row) => ({ id: String(row.id), checksum: String(row.checksum) }))
      } catch (err) {
        throw journalError(err, 'Migration journal could not be read.', 'MIGRATION_FAILED')
      }
    },

    async ensure() {
      try {
        await execStatic(conn(), JOURNAL_SQL)
      } catch (err) {
        throw journalError(err, 'Migration journal could not be created.', 'MIGRATION_FAILED')
      }
    },

    async record(id, checksum) {
      if (typeof id !== 'string' || typeof checksum !== 'string') {
        throw new BreadError('Migration step id is invalid.', 'MIGRATION_INVALID', {})
      }
      try {
        const result = await executeSql(
          conn(),
          'INSERT INTO bread_migrations (id, checksum, applied_at) VALUES (?, ?, ?)',
          [id, checksum, Date.now()],
        )
        return result.affectedRows === 1
      } catch (err) {
        if (isDuplicate(err)) return false
        throw journalError(err, 'Migration journal could not be written.', 'MIGRATION_FAILED')
      }
    },
  }

  const steps: MigrationStep[] = [
    {
      id: BASELINE_ID,
      checksum: BASELINE_CHECKSUM,
      up: async () => {
        // DDL implicit-commits. GET_LOCK stays on this connection, and record()
        // runs only after every statement here has succeeded.
        const db = conn()
        for (const statement of CREATE_STATEMENTS) await execStatic(db, statement)
        for (const guard of GUARDS) {
          if (await hasColumn(db, guard.table, guard.column)) continue
          await execStatic(db, guard.sql)
        }
        for (const index of INDEXES) {
          if (await hasIndex(db, index.table, index.name)) continue
          await execStatic(db, index.sql)
        }
      },
    },
  ]
  return { journal, steps, knownIds: [] }
}
