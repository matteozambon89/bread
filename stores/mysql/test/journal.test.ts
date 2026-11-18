import { createConnection, type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { BreadError, migrationChecksum } from '@breadai/core'
import { store } from '@breadai/store-mysql'
import { mysqlConfig } from '../src/connect.ts'
import { BASELINE_ID, BASELINE_TEXT, MIGRATION_LOCK_NAME } from '../src/migrate.ts'
import { startMysql, type MysqlFixture } from './harness.ts'

let fixture: MysqlFixture

beforeAll(async () => {
  fixture = await startMysql()
}, 300_000)

afterAll(async () => {
  await fixture?.stop()
})

async function fresh(): Promise<void> {
  await fixture.drop()
}

test('store() does not create tables and a missing journal is pending', async () => {
  await fresh()
  const backend = store(fixture.opts)
  try {
    await expect(backend.listSessions()).rejects.toThrow()
    await expect(backend.migrations?.()).rejects.toMatchObject({
      code: 'MIGRATIONS_PENDING',
      context: { reason: 'missing_journal' },
    })
    const tables = await fixture.query(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('bread_sessions', 'bread_migrations')`,
    )
    expect(tables).toHaveLength(0)
  } finally {
    await backend.close?.()
  }
})

test('migrate records 0001_baseline and a second call skips it', async () => {
  await fresh()
  const backend = store(fixture.opts)
  try {
    expect(await backend.migrate?.()).toEqual({ applied: [BASELINE_ID], skipped: [] })
    expect(await backend.migrations?.()).toEqual({ pending: [] })
    expect(await backend.migrate?.()).toEqual({ applied: [], skipped: [BASELINE_ID] })
    expect(await backend.listSessions()).toEqual([])
  } finally {
    await backend.close?.()
  }
})

test('an existing schema adopts 0001 without dropping leftover bread_kg tables', async () => {
  await fresh()
  await fixture.ddl(`CREATE TABLE bread_sessions (
    id VARCHAR(128) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    agent_id VARCHAR(128) NULL,
    tags JSON NOT NULL,
    PRIMARY KEY (id)
  )`)
  await fixture.ddl('CREATE TABLE bread_kg_nodes (id VARCHAR(128) NOT NULL, PRIMARY KEY (id))')
  const backend = store(fixture.opts)
  try {
    expect(await backend.migrate?.()).toEqual({ applied: [BASELINE_ID], skipped: [] })
    expect(await backend.listSessions()).toEqual([])
  } finally {
    await backend.close?.()
  }
  const columns = await fixture.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bread_sessions' AND COLUMN_NAME = 'principal'`,
  )
  expect(columns).toHaveLength(1)
  const kg = await fixture.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bread_kg_nodes'`,
  )
  expect(kg).toHaveLength(1)
  const journal = await fixture.query('SELECT checksum FROM bread_migrations WHERE id = ?', [BASELINE_ID])
  expect(journal[0]?.checksum).toBe(migrationChecksum(BASELINE_TEXT))
})

test('a changed checksum is not rewritten and an unknown id is ahead', async () => {
  await fresh()
  const backend = store(fixture.opts)
  try {
    await backend.migrate?.()
  } finally {
    await backend.close?.()
  }
  const wrong = 'ab'.repeat(32)
  await fixture.query('UPDATE bread_migrations SET checksum = ? WHERE id = ?', [wrong, BASELINE_ID])
  const changed = store(fixture.opts)
  try {
    await expect(changed.migrations?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })
    await expect(changed.migrate?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })
  } finally {
    await changed.close?.()
  }
  const kept = await fixture.query('SELECT checksum FROM bread_migrations WHERE id = ?', [BASELINE_ID])
  expect(kept[0]?.checksum).toBe(wrong)
  await fixture.query('UPDATE bread_migrations SET checksum = ? WHERE id = ?', [migrationChecksum(BASELINE_TEXT), BASELINE_ID])
  await fixture.query('INSERT INTO bread_migrations (id, checksum, applied_at) VALUES (?, ?, ?)', [
    'not a step',
    'ef',
    1,
  ])
  const ahead = store(fixture.opts)
  try {
    await ahead.migrations?.()
    throw new Error('expected ahead')
  } catch (err) {
    expect(err).toBeInstanceOf(BreadError)
    expect((err as BreadError).code).toBe('MIGRATION_AHEAD')
    expect((err as BreadError).message).not.toContain('not a step')
  } finally {
    await ahead.close?.()
  }
})

test('a lock that is not acquired aborts migrate', async () => {
  await fresh()
  const held = await createConnection(mysqlConfig(fixture.opts))
  const backend = store(fixture.opts)
  try {
    const [rows] = await held.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS locked', [MIGRATION_LOCK_NAME])
    if (Number(rows[0]?.locked) !== 1) throw new Error('test could not acquire the migration lock')
    try {
      await backend.migrate?.()
      throw new Error('expected lock failure')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('MIGRATION_LOCK')
      expect((err as BreadError).message).toBe('Could not acquire the migration lock.')
    }
  } finally {
    await held.execute('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK_NAME])
    await held.end()
    await backend.close?.()
  }
})

test('keyword search escapes LIKE wildcards', async () => {
  await fresh()
  const backend = store(fixture.opts)
  try {
    await backend.migrate?.()
    const principal = { iss: 'https://idp.example', sub: 'ada' }
    await backend.addMemory?.({ agentId: 'a', principal, content: '100% done' })
    await backend.addMemory?.({ agentId: 'a', principal, content: '1000 done' })
    const hits = await backend.searchMemories?.({ agentId: 'a', principal, query: '100%' })
    expect(hits?.map((row) => row.content)).toEqual(['100% done'])
    await backend.ingestDocument?.({ agentId: 'a', title: '100% notes', content: 'plain' })
    await backend.ingestDocument?.({ agentId: 'a', title: 'other', content: '1000 notes' })
    const docs = await backend.searchDocuments?.({ agentId: 'a', query: '100%' })
    expect(docs?.map((doc) => doc.title)).toEqual(['100% notes'])
  } finally {
    await backend.close?.()
  }
})
