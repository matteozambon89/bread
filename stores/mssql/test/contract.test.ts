import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MSSQLServerContainer, type StartedMSSQLServerContainer } from '@testcontainers/mssqlserver'
import sql from 'mssql'
import { BreadError, migrationChecksum } from '@breadai/core'
import { store } from '@breadai/store-mssql'
import { runStoreContract } from '@breadai/test-utils'
import { resolveMssqlConfig } from '../src/config.ts'
import { BASELINE_TEXT, LOCK_RESOURCE } from '../src/migrate.ts'

// ACCEPT_EULA is required by the SQL Server image. The store never sets it.
const SA_PASSWORD = 'Bread_test_only_1a'
// 2022-latest is amd64-only and exits under QEMU. ARM hosts use Azure SQL Edge,
// which speaks the same TDS surface. CI runners are amd64 and use 2022-latest.
const IMAGE =
  process.arch === 'arm64'
    ? 'mcr.microsoft.com/azure-sql-edge:latest'
    : 'mcr.microsoft.com/mssql/server:2022-latest'

let url = ''
let admin: sql.ConnectionPool | undefined
let container: StartedMSSQLServerContainer | undefined

function testStore() {
  if (url === '') throw new Error('SQL Server test URL is not ready')
  return store({ url, loopback: true })
}

async function exec(text: string, bind?: (request: sql.Request) => void): Promise<sql.IResult<unknown>> {
  if (!admin) throw new Error('SQL Server test pool is not open')
  const request = admin.request()
  bind?.(request)
  return request.query(text)
}

const RESET_SQL = `
IF OBJECT_ID(N'dbo.bread_loop_iterations', N'U') IS NOT NULL DELETE FROM dbo.bread_loop_iterations;
IF OBJECT_ID(N'dbo.bread_crumbs', N'U') IS NOT NULL DELETE FROM dbo.bread_crumbs;
IF OBJECT_ID(N'dbo.bread_checkpoints', N'U') IS NOT NULL DELETE FROM dbo.bread_checkpoints;
IF OBJECT_ID(N'dbo.bread_session_messages', N'U') IS NOT NULL DELETE FROM dbo.bread_session_messages;
IF OBJECT_ID(N'dbo.bread_sessions', N'U') IS NOT NULL DELETE FROM dbo.bread_sessions;
IF OBJECT_ID(N'dbo.bread_loops', N'U') IS NOT NULL DELETE FROM dbo.bread_loops;
IF OBJECT_ID(N'dbo.bread_memories', N'U') IS NOT NULL DELETE FROM dbo.bread_memories;
IF OBJECT_ID(N'dbo.bread_documents', N'U') IS NOT NULL DELETE FROM dbo.bread_documents;
IF OBJECT_ID(N'dbo.bread_task_runs', N'U') IS NOT NULL DELETE FROM dbo.bread_task_runs;
`

const DROP_SQL = `
DROP TABLE IF EXISTS dbo.bread_session_messages;
DROP TABLE IF EXISTS dbo.bread_checkpoints;
DROP TABLE IF EXISTS dbo.bread_crumbs;
DROP TABLE IF EXISTS dbo.bread_loop_iterations;
DROP TABLE IF EXISTS dbo.bread_loops;
DROP TABLE IF EXISTS dbo.bread_memories;
DROP TABLE IF EXISTS dbo.bread_documents;
DROP TABLE IF EXISTS dbo.bread_task_runs;
DROP TABLE IF EXISTS dbo.bread_sessions;
DROP TABLE IF EXISTS dbo.bread_migrations;
DROP TABLE IF EXISTS dbo.bread_kg_nodes;
`

beforeAll(async () => {
  const fromEnv = process.env.MSSQL_URL
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    url = fromEnv.trim()
  } else {
    const builder = new MSSQLServerContainer(IMAGE)
    builder.acceptLicense()
    builder.withPassword(SA_PASSWORD)
    builder.withStartupTimeout(180_000)
    const started = await builder.start()
    container = started
    const user = encodeURIComponent(started.getUsername())
    const password = encodeURIComponent(started.getPassword())
    const database = started.getDatabase()
    url = `mssql://${user}:${password}@127.0.0.1:${started.getPort()}/${database}`
  }
  resolveMssqlConfig({ url, loopback: true })
  admin = new sql.ConnectionPool(resolveMssqlConfig({ url, loopback: true }))
  await admin.connect()
}, 600_000)

afterAll(async () => {
  await admin?.close()
  await container?.stop()
})

runStoreContract('mssql', () => testStore(), {
  reset: async () => {
    await exec(RESET_SQL)
  },
})

test('search escapes like wildcards', async () => {
  const backend = testStore()
  try {
    await backend.migrate?.()
    const principal = { iss: 'https://idp.example', sub: 'ada' }
    await backend.addMemory?.({ agentId: 'a', principal, content: '100% sure' })
    await backend.addMemory?.({ agentId: 'a', principal, content: 'other' })
    const hits = await backend.searchMemories?.({ agentId: 'a', principal, query: '100%' })
    expect(hits?.map((hit) => hit.content)).toEqual(['100% sure'])
  } finally {
    await backend.close?.()
    await exec(RESET_SQL)
  }
}, 60_000)

test('a missing journal is pending and migrate then skips 0001_baseline', async () => {
  await exec(DROP_SQL)
  const backend = testStore()
  try {
    await expect(backend.migrations?.()).rejects.toMatchObject({
      code: 'MIGRATIONS_PENDING',
      context: { reason: 'missing_journal' },
    })
    expect(await backend.migrate?.()).toEqual({ applied: ['0001_baseline'], skipped: [] })
    expect(await backend.migrations?.()).toEqual({ pending: [] })
    expect(await backend.migrate?.()).toEqual({ applied: [], skipped: ['0001_baseline'] })
    expect(await backend.listSessions()).toEqual([])
  } finally {
    await backend.close?.()
  }
}, 60_000)

test('an existing schema adopts 0001 without dropping leftover bread_kg tables', async () => {
  await exec(DROP_SQL)
  await exec(`CREATE TABLE dbo.bread_sessions (
    id NVARCHAR(450) NOT NULL PRIMARY KEY,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    agent_id NVARCHAR(450) NULL,
    tags NVARCHAR(MAX) NOT NULL CONSTRAINT DF_adopt_tags DEFAULT N'{}'
  )`)
  await exec('CREATE TABLE dbo.bread_kg_nodes (id NVARCHAR(450) NULL)')
  const backend = testStore()
  try {
    expect(await backend.migrate?.()).toEqual({ applied: ['0001_baseline'], skipped: [] })
    expect(await backend.listSessions()).toEqual([])
  } finally {
    await backend.close?.()
  }
  const columns = await exec(`SELECT COL_LENGTH(N'dbo.bread_sessions', N'principal') AS len`)
  const len = (columns.recordset[0] as { len: number | null } | undefined)?.len
  expect(len).not.toBeNull()
  const kept = await exec(`SELECT OBJECT_ID(N'dbo.bread_kg_nodes', N'U') AS id`)
  expect((kept.recordset[0] as { id: number | null } | undefined)?.id).not.toBeNull()
  const row = await exec(
    `SELECT checksum FROM dbo.bread_migrations WHERE id = N'0001_baseline'`,
  )
  expect((row.recordset[0] as { checksum: string }).checksum).toBe(migrationChecksum(BASELINE_TEXT))
}, 60_000)

test('a changed checksum is not rewritten and an extra id is ahead', async () => {
  const backend = testStore()
  try {
    await backend.migrate?.()
    await exec(`UPDATE dbo.bread_migrations SET checksum = @checksum WHERE id = N'0001_baseline'`, (request) => {
      request.input('checksum', sql.NVarChar(64), 'ab'.repeat(32))
    })
    await expect(backend.migrations?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })
    await expect(backend.migrate?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })
    const kept = await exec(`SELECT checksum FROM dbo.bread_migrations WHERE id = N'0001_baseline'`)
    expect((kept.recordset[0] as { checksum: string }).checksum).toBe('ab'.repeat(32))
    await exec(`UPDATE dbo.bread_migrations SET checksum = @checksum WHERE id = N'0001_baseline'`, (request) => {
      request.input('checksum', sql.NVarChar(64), migrationChecksum(BASELINE_TEXT))
    })
    await exec(
      `INSERT INTO dbo.bread_migrations (id, checksum, applied_at) VALUES (@id, @checksum, 1)`,
      (request) => {
        request.input('id', sql.NVarChar(128), 'not a step')
        request.input('checksum', sql.NVarChar(64), 'ef')
      },
    )
    try {
      await backend.migrations?.()
      throw new Error('expected ahead')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('MIGRATION_AHEAD')
      expect((err as BreadError).message).not.toContain('not a step')
    }
  } finally {
    await backend.close?.()
    await exec(DROP_SQL)
    const restore = testStore()
    try {
      await restore.migrate?.()
    } finally {
      await restore.close?.()
    }
  }
}, 60_000)

test('a lock that is not acquired aborts migrate', async () => {
  const pool = new sql.ConnectionPool(resolveMssqlConfig({ url, loopback: true }))
  await pool.connect()
  const tx = new sql.Transaction(pool)
  await tx.begin()
  try {
    const request = tx.request()
    request.input('resource', sql.NVarChar(255), LOCK_RESOURCE)
    request.input('mode', sql.NVarChar(32), 'Exclusive')
    request.input('owner', sql.NVarChar(32), 'Transaction')
    request.input('timeout', sql.Int, 10_000)
    const locked = await request.query(`
      DECLARE @result INT;
      EXEC @result = sp_getapplock
        @Resource = @resource,
        @LockMode = @mode,
        @LockOwner = @owner,
        @LockTimeout = @timeout;
      SELECT @result AS result;
    `)
    const code = Number((locked.recordset[0] as { result: number } | undefined)?.result)
    if (!Number.isFinite(code) || code < 0) throw new Error('test could not acquire the migration lock')
    const backend = testStore()
    try {
      await expect(backend.migrate?.()).rejects.toMatchObject({ code: 'MIGRATION_LOCK' })
      const err = await backend.migrate?.().then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).message).toBe('Could not acquire the migration lock.')
    } finally {
      await backend.close?.()
    }
  } finally {
    try {
      await tx.rollback()
    } catch {
      // The lock assertion is the failure this test keeps.
    }
    await pool.close()
  }
}, 60_000)
