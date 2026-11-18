import {
  BreadError,
  migrationChecksum,
  readMigrationStatus,
  redactConnectionSecrets,
  runMigrations,
  type MigrationJournal,
  type MigrationReport,
  type MigrationStep,
} from '@breadai/core'
import sql, { type ConnectionPool, type IResult, type Request, type Transaction } from 'mssql'
import { driverNumber, isDuplicateIndex, redactDriver } from './errors.js'

export const BASELINE_ID = '0001_baseline'
export const LOCK_RESOURCE = 'bread_migrate'

interface StepStatement {
  text: string
  index?: boolean
}

const STATEMENTS: readonly StepStatement[] = [
  {
    text: `-- Leftover bread_kg_* tables are not dropped. This migration does not read them.`,
  },
  {
    text: `IF OBJECT_ID(N'dbo.bread_sessions', N'U') IS NULL
CREATE TABLE dbo.bread_sessions (
  id NVARCHAR(450) NOT NULL PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  agent_id NVARCHAR(450) NULL,
  tags NVARCHAR(MAX) NOT NULL CONSTRAINT DF_bread_sessions_tags DEFAULT N'{}',
  principal NVARCHAR(MAX) NULL
);`,
  },
  {
    text: `IF OBJECT_ID(N'dbo.bread_session_messages', N'U') IS NULL
CREATE TABLE dbo.bread_session_messages (
  id NVARCHAR(450) NOT NULL PRIMARY KEY,
  session_id NVARCHAR(450) NOT NULL REFERENCES dbo.bread_sessions(id) ON DELETE CASCADE,
  [role] NVARCHAR(32) NOT NULL,
  content NVARCHAR(MAX) NOT NULL,
  [timestamp] BIGINT NOT NULL
);`,
  },
  {
    text: `IF OBJECT_ID(N'dbo.bread_checkpoints', N'U') IS NULL
CREATE TABLE dbo.bread_checkpoints (
  id NVARCHAR(450) NOT NULL PRIMARY KEY,
  agent_id NVARCHAR(450) NOT NULL,
  run_id NVARCHAR(450) NOT NULL,
  session_id NVARCHAR(450) NOT NULL REFERENCES dbo.bread_sessions(id) ON DELETE CASCADE,
  execution_id NVARCHAR(450) NOT NULL CONSTRAINT DF_bread_checkpoints_execution DEFAULT N'',
  tool_name NVARCHAR(256) NOT NULL,
  tool_call_id NVARCHAR(450) NOT NULL,
  [schema] NVARCHAR(MAX) NOT NULL,
  prompt NVARCHAR(MAX) NULL,
  skill NVARCHAR(256) NULL,
  parent NVARCHAR(MAX) NULL,
  pending NVARCHAR(MAX) NULL,
  principal NVARCHAR(MAX) NULL,
  claimed INT NOT NULL CONSTRAINT DF_bread_checkpoints_claimed DEFAULT 0,
  created_at BIGINT NOT NULL
);`,
  },
  {
    text: `IF OBJECT_ID(N'dbo.bread_loops', N'U') IS NULL
CREATE TABLE dbo.bread_loops (
  id NVARCHAR(450) NOT NULL PRIMARY KEY,
  agent_id NVARCHAR(450) NOT NULL,
  session_id NVARCHAR(450) NOT NULL,
  run_id NVARCHAR(450) NOT NULL,
  pool NVARCHAR(MAX) NOT NULL,
  pipeline NVARCHAR(MAX) NOT NULL,
  max_iterations INT NOT NULL,
  status NVARCHAR(64) NOT NULL,
  iterations INT NOT NULL CONSTRAINT DF_bread_loops_iterations DEFAULT 0,
  result NVARCHAR(MAX) NULL,
  last_output NVARCHAR(MAX) NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT NULL
);`,
  },
  {
    text: `IF OBJECT_ID(N'dbo.bread_loop_iterations', N'U') IS NULL
CREATE TABLE dbo.bread_loop_iterations (
  id NVARCHAR(450) NOT NULL PRIMARY KEY,
  loop_id NVARCHAR(450) NOT NULL REFERENCES dbo.bread_loops(id) ON DELETE CASCADE,
  idx INT NOT NULL,
  input NVARCHAR(MAX) NULL,
  output NVARCHAR(MAX) NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT NOT NULL
);`,
  },
  {
    text: `IF OBJECT_ID(N'dbo.bread_memories', N'U') IS NULL
CREATE TABLE dbo.bread_memories (
  id NVARCHAR(450) NOT NULL PRIMARY KEY,
  agent_id NVARCHAR(256) NOT NULL,
  principal_iss NVARCHAR(256) NOT NULL,
  principal_sub NVARCHAR(256) NOT NULL,
  content NVARCHAR(MAX) NOT NULL,
  created_at BIGINT NOT NULL
);`,
  },
  {
    text: `IF OBJECT_ID(N'dbo.bread_documents', N'U') IS NULL
CREATE TABLE dbo.bread_documents (
  id NVARCHAR(450) NOT NULL PRIMARY KEY,
  agent_id NVARCHAR(450) NOT NULL,
  title NVARCHAR(MAX) NOT NULL,
  content NVARCHAR(MAX) NOT NULL,
  source NVARCHAR(MAX) NULL,
  created_at BIGINT NOT NULL
);`,
  },
  {
    text: `IF OBJECT_ID(N'dbo.bread_crumbs', N'U') IS NULL
CREATE TABLE dbo.bread_crumbs (
  run_id NVARCHAR(450) NOT NULL,
  seq BIGINT NOT NULL,
  session_id NVARCHAR(450) NULL REFERENCES dbo.bread_sessions(id) ON DELETE CASCADE,
  agent_id NVARCHAR(450) NULL,
  [type] NVARCHAR(256) NOT NULL,
  crumb NVARCHAR(MAX) NOT NULL,
  created_at BIGINT NOT NULL,
  CONSTRAINT PK_bread_crumbs PRIMARY KEY (run_id, seq)
);`,
  },
  {
    text: `IF OBJECT_ID(N'dbo.bread_task_runs', N'U') IS NULL
CREATE TABLE dbo.bread_task_runs (
  id NVARCHAR(450) NOT NULL PRIMARY KEY,
  task_id NVARCHAR(450) NOT NULL,
  agent_id NVARCHAR(450) NULL,
  session_id NVARCHAR(450) NULL,
  run_id NVARCHAR(450) NULL,
  model NVARCHAR(MAX) NOT NULL,
  input NVARCHAR(MAX) NULL,
  output NVARCHAR(MAX) NULL,
  status NVARCHAR(64) NOT NULL,
  usage NVARCHAR(MAX) NULL,
  error NVARCHAR(MAX) NULL,
  duration_ms INT NULL,
  created_at BIGINT NOT NULL,
  completed_at BIGINT NULL
);`,
  },
  {
    text: `IF COL_LENGTH(N'dbo.bread_checkpoints', N'skill') IS NULL
ALTER TABLE dbo.bread_checkpoints ADD skill NVARCHAR(256) NULL;`,
  },
  {
    text: `IF COL_LENGTH(N'dbo.bread_checkpoints', N'parent') IS NULL
ALTER TABLE dbo.bread_checkpoints ADD parent NVARCHAR(MAX) NULL;`,
  },
  {
    text: `IF COL_LENGTH(N'dbo.bread_checkpoints', N'pending') IS NULL
ALTER TABLE dbo.bread_checkpoints ADD pending NVARCHAR(MAX) NULL;`,
  },
  {
    text: `IF COL_LENGTH(N'dbo.bread_checkpoints', N'principal') IS NULL
ALTER TABLE dbo.bread_checkpoints ADD principal NVARCHAR(MAX) NULL;`,
  },
  {
    text: `IF COL_LENGTH(N'dbo.bread_checkpoints', N'claimed') IS NULL
ALTER TABLE dbo.bread_checkpoints ADD claimed INT NOT NULL CONSTRAINT DF_bread_checkpoints_claimed DEFAULT 0;`,
  },
  {
    text: `IF COL_LENGTH(N'dbo.bread_checkpoints', N'execution_id') IS NULL
ALTER TABLE dbo.bread_checkpoints ADD execution_id NVARCHAR(450) NOT NULL CONSTRAINT DF_bread_checkpoints_execution DEFAULT N'';`,
  },
  {
    text: `IF COL_LENGTH(N'dbo.bread_sessions', N'principal') IS NULL
ALTER TABLE dbo.bread_sessions ADD principal NVARCHAR(MAX) NULL;`,
  },
  {
    text: `IF COL_LENGTH(N'dbo.bread_loops', N'last_output') IS NULL
ALTER TABLE dbo.bread_loops ADD last_output NVARCHAR(MAX) NULL;`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_sm_session' AND object_id = OBJECT_ID(N'dbo.bread_session_messages')
)
CREATE INDEX idx_bread_sm_session ON dbo.bread_session_messages(session_id);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_s_updated' AND object_id = OBJECT_ID(N'dbo.bread_sessions')
)
CREATE INDEX idx_bread_s_updated ON dbo.bread_sessions(updated_at);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_checkpoints_execution' AND object_id = OBJECT_ID(N'dbo.bread_checkpoints')
)
CREATE INDEX idx_bread_checkpoints_execution ON dbo.bread_checkpoints(execution_id);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_loops_session' AND object_id = OBJECT_ID(N'dbo.bread_loops')
)
CREATE INDEX idx_bread_loops_session ON dbo.bread_loops(session_id);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_loops_agent' AND object_id = OBJECT_ID(N'dbo.bread_loops')
)
CREATE INDEX idx_bread_loops_agent ON dbo.bread_loops(agent_id);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_loop_iter_loop' AND object_id = OBJECT_ID(N'dbo.bread_loop_iterations')
)
CREATE INDEX idx_bread_loop_iter_loop ON dbo.bread_loop_iterations(loop_id);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_memories_owner' AND object_id = OBJECT_ID(N'dbo.bread_memories')
)
CREATE INDEX idx_bread_memories_owner ON dbo.bread_memories(agent_id, principal_iss, principal_sub);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_documents_agent' AND object_id = OBJECT_ID(N'dbo.bread_documents')
)
CREATE INDEX idx_bread_documents_agent ON dbo.bread_documents(agent_id);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_crumbs_session' AND object_id = OBJECT_ID(N'dbo.bread_crumbs')
)
CREATE INDEX idx_bread_crumbs_session ON dbo.bread_crumbs(session_id);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_task_runs_task' AND object_id = OBJECT_ID(N'dbo.bread_task_runs')
)
CREATE INDEX idx_bread_task_runs_task ON dbo.bread_task_runs(task_id);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_task_runs_session' AND object_id = OBJECT_ID(N'dbo.bread_task_runs')
)
CREATE INDEX idx_bread_task_runs_session ON dbo.bread_task_runs(session_id);`,
  },
  {
    index: true,
    text: `IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'idx_bread_task_runs_agent' AND object_id = OBJECT_ID(N'dbo.bread_task_runs')
)
CREATE INDEX idx_bread_task_runs_agent ON dbo.bread_task_runs(agent_id);`,
  },
]

const JOURNAL_SQL = `IF OBJECT_ID(N'dbo.bread_migrations', N'U') IS NULL
CREATE TABLE dbo.bread_migrations (
  id NVARCHAR(128) NOT NULL PRIMARY KEY,
  checksum NVARCHAR(64) NOT NULL,
  applied_at BIGINT NOT NULL
);`

export const BASELINE_TEXT = STATEMENTS.map((statement) => statement.text).join('\n')
const BASELINE_CHECKSUM = migrationChecksum(BASELINE_TEXT)

const LOCK_SQL = `DECLARE @result INT;
EXEC @result = sp_getapplock
  @Resource = @resource,
  @LockMode = @mode,
  @LockOwner = @owner,
  @LockTimeout = @timeout;
SELECT @result AS result;`

export function journalFailure(err: unknown, fallback: string, code: string): BreadError {
  if (err instanceof BreadError) {
    return new BreadError(redactConnectionSecrets(err.message), err.code, err.context, redactDriver(err.cause))
  }
  const number = driverNumber(err)
  if (number === 208) {
    return new BreadError('Migration journal is missing.', 'MIGRATION_JOURNAL_MISSING', {}, redactDriver(err))
  }
  if (number === 229 || number === 262) {
    return new BreadError('Migration journal could not be read.', 'MIGRATION_JOURNAL_FORBIDDEN', {}, redactDriver(err))
  }
  return new BreadError(fallback, code, {}, redactDriver(err))
}

function rowsOf<T>(result: IResult<T>): T[] {
  return result.recordset ? [...result.recordset] : []
}

export function mssqlMigration(pool: ConnectionPool): {
  journal: MigrationJournal
  steps: MigrationStep[]
  knownIds: string[]
} {
  let pinned: Transaction | null = null
  const conn = (): Transaction => {
    if (!pinned) throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {})
    return pinned
  }

  async function locked<T>(text: string, bind?: (request: Request) => void): Promise<IResult<T>> {
    const request = conn().request()
    bind?.(request)
    return request.query<T>(text)
  }

  // SQL Server has no CREATE INDEX IF NOT EXISTS. 1913/2714 is the duplicate the
  // existence check can still hit; any other error, or a doomed transaction, is rethrown.
  async function runStatement(statement: StepStatement): Promise<void> {
    try {
      await locked(statement.text)
    } catch (err) {
      if (!statement.index || !isDuplicateIndex(err)) throw err
      let state: number | undefined
      try {
        const result = await locked<{ state: number }>('SELECT XACT_STATE() AS state')
        state = rowsOf(result)[0]?.state
      } catch {
        throw err
      }
      if (state !== 1) throw err
    }
  }

  const journal: MigrationJournal = {
    async lock() {
      let tx: Transaction | null = null
      try {
        tx = new sql.Transaction(pool)
        await tx.begin()
        const request = tx.request()
        request.input('resource', sql.NVarChar(255), LOCK_RESOURCE)
        request.input('mode', sql.NVarChar(32), 'Exclusive')
        request.input('owner', sql.NVarChar(32), 'Transaction')
        request.input('timeout', sql.Int, 0)
        const lockedRows = await request.query<{ result: number }>(LOCK_SQL)
        const code = Number(lockedRows.recordset?.[0]?.result)
        if (!Number.isFinite(code) || code < 0) {
          await tx.rollback()
          tx = null
          throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {})
        }
      } catch (err) {
        if (tx) {
          try {
            await tx.rollback()
          } catch {
            // The lock error is the one callers need.
          }
        }
        if (err instanceof BreadError && err.code === 'MIGRATION_LOCK') throw err
        throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {}, redactDriver(err))
      }
      pinned = tx
      let released = false
      const release = async (mode: 'commit' | 'rollback'): Promise<void> => {
        if (released || !tx) return
        released = true
        pinned = null
        try {
          if (mode === 'commit') await tx.commit()
          else await tx.rollback()
        } catch (err) {
          try {
            await tx.rollback()
          } catch {
            // The original failure is the one callers need.
          }
          throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {}, redactDriver(err))
        }
      }
      // LockOwner Transaction releases on commit and rollback, including a dropped connection.
      return { commit: () => release('commit'), rollback: () => release('rollback') }
    },

    async applied() {
      try {
        const present = await locked<{ present: number }>(
          `SELECT CASE WHEN OBJECT_ID(N'dbo.bread_migrations', N'U') IS NULL THEN 0 ELSE 1 END AS present`,
        )
        if (Number(rowsOf(present)[0]?.present) !== 1) {
          throw new BreadError('Migration journal is missing.', 'MIGRATION_JOURNAL_MISSING', {})
        }
        const result = await locked<{ id: string; checksum: string }>(
          'SELECT id, checksum FROM dbo.bread_migrations ORDER BY id',
        )
        return rowsOf(result).map((row) => ({ id: row.id, checksum: row.checksum }))
      } catch (err) {
        throw journalFailure(err, 'Migration journal could not be read.', 'MIGRATION_FAILED')
      }
    },

    async ensure() {
      try {
        await locked(JOURNAL_SQL)
      } catch (err) {
        throw journalFailure(err, 'Migration journal could not be created.', 'MIGRATION_FAILED')
      }
    },

    async record(id, checksum) {
      if (typeof id !== 'string' || typeof checksum !== 'string') {
        throw new BreadError('Migration step id is invalid.', 'MIGRATION_INVALID', {})
      }
      try {
        await locked(
          `INSERT INTO dbo.bread_migrations (id, checksum, applied_at) VALUES (@id, @checksum, @appliedAt)`,
          (request) => {
            request.input('id', sql.NVarChar(128), id)
            request.input('checksum', sql.NVarChar(64), checksum)
            request.input('appliedAt', sql.BigInt, String(Date.now()))
          },
        )
        return true
      } catch (err) {
        const number = driverNumber(err)
        if (number === 2627 || number === 2601) return false
        throw journalFailure(err, 'Migration journal could not be written.', 'MIGRATION_FAILED')
      }
    },
  }

  const steps: MigrationStep[] = [
    {
      id: BASELINE_ID,
      checksum: BASELINE_CHECKSUM,
      up: async () => {
        for (const statement of STATEMENTS) await runStatement(statement)
      },
    },
  ]
  return { journal, steps, knownIds: [] }
}

export async function migratePool(pool: ConnectionPool): Promise<MigrationReport> {
  const plan = mssqlMigration(pool)
  return runMigrations(plan.journal, plan.steps, plan.knownIds)
}

export async function migrationStatus(pool: ConnectionPool): Promise<{ pending: string[] }> {
  const plan = mssqlMigration(pool)
  return readMigrationStatus(plan.journal, plan.steps, plan.knownIds)
}
