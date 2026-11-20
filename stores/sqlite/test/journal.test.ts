import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { BreadError, migrationChecksum } from '@breadai/core'
import { store } from '@breadai/store-sqlite'
import { BASELINE_TEXT } from '../src/migrate.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bread-sqlite-'))
  dirs.push(dir)
  return join(dir, 'bread.db')
}

test('store() opens the file and does not create tables', async () => {
  const backend = store({ path: ':memory:' })
  try {
    await expect(backend.listSessions()).rejects.toThrow(/no such table/i)
    await expect(backend.migrations?.()).rejects.toMatchObject({ code: 'MIGRATIONS_PENDING' })
  } finally {
    await backend.close?.()
  }
})

test('migrate records 0001_baseline and a second call skips it', async () => {
  const backend = store({ path: ':memory:' })
  try {
    expect(await backend.migrate?.()).toEqual({ applied: ['0001_baseline'], skipped: [] })
    expect(await backend.migrations?.()).toEqual({ pending: [] })
    expect(await backend.migrate?.()).toEqual({ applied: [], skipped: ['0001_baseline'] })
    expect(await backend.listSessions()).toEqual([])
  } finally {
    await backend.close?.()
  }
})

test('an existing database adopts 0001 by running the idempotent schema', async () => {
  const path = file()
  const raw = new Database(path)
  raw.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    agent_id TEXT,
    tags TEXT NOT NULL DEFAULT '{}'
  )`)
  raw.exec('CREATE TABLE kg_nodes (id TEXT)')
  raw.close()

  const backend = store({ path })
  try {
    expect(await backend.migrate?.()).toEqual({ applied: ['0001_baseline'], skipped: [] })
    expect(await backend.listSessions()).toEqual([])
  } finally {
    await backend.close?.()
  }

  const look = new Database(path)
  try {
    const columns = look.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('principal')
    expect(look.prepare("SELECT name FROM sqlite_master WHERE name = 'kg_nodes'").get()).toBeTruthy()
    const row = look.prepare('SELECT checksum FROM bread_migrations WHERE id = ?').get('0001_baseline') as {
      checksum: string
    }
    expect(row.checksum).toBe(migrationChecksum(BASELINE_TEXT))
  } finally {
    look.close()
  }
})

test('a changed checksum is not rewritten and an extra id is ahead', async () => {
  const path = file()
  const backend = store({ path })
  try {
    await backend.migrate?.()
    const raw = new Database(path)
    raw.exec(`UPDATE bread_migrations SET checksum = '${'ab'.repeat(32)}' WHERE id = '0001_baseline'`)
    raw.close()
    await expect(backend.migrations?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })
    await expect(backend.migrate?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })

    const look = new Database(path)
    const kept = look.prepare('SELECT checksum FROM bread_migrations WHERE id = ?').get('0001_baseline') as {
      checksum: string
    }
    expect(kept.checksum).toBe('ab'.repeat(32))
    look.exec(`UPDATE bread_migrations SET checksum = '${migrationChecksum(BASELINE_TEXT)}' WHERE id = '0001_baseline'`)
    look.exec("INSERT INTO bread_migrations (id, checksum, applied_at) VALUES ('not a step', 'ef', 1)")
    look.close()
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
  }
})

test('a file lock that is not acquired aborts migrate', async () => {
  const path = file()
  const backend = store({ path })
  const other = new Database(path)
  try {
    other.exec('BEGIN IMMEDIATE')
    try {
      await backend.migrate?.()
      throw new Error('expected lock failure')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('MIGRATION_LOCK')
      expect((err as BreadError).message).toBe('Could not acquire the migration lock.')
    }
  } finally {
    other.exec('ROLLBACK')
    other.close()
    await backend.close?.()
  }
})
