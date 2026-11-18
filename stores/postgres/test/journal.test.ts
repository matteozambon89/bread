import { afterAll, beforeAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { BreadError, migrationChecksum } from '@breadai/core'
import { store } from '@breadai/store-postgres'
import { type PgliteHandle, withPglite } from '@breadai/test-utils'
import { BASELINE_TEXT, VECTOR_ID } from '../src/migrate.ts'

let pg: PgliteHandle

beforeAll(async () => {
  pg = await withPglite()
})

afterAll(async () => {
  await pg.close()
})

async function reset(): Promise<void> {
  const admin = postgres(pg.url, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`
      DROP TABLE IF EXISTS bread_migrations CASCADE;
      DROP TABLE IF EXISTS bread_session_messages CASCADE;
      DROP TABLE IF EXISTS bread_checkpoints CASCADE;
      DROP TABLE IF EXISTS bread_loop_iterations CASCADE;
      DROP TABLE IF EXISTS bread_loops CASCADE;
      DROP TABLE IF EXISTS bread_crumbs CASCADE;
      DROP TABLE IF EXISTS bread_task_runs CASCADE;
      DROP TABLE IF EXISTS bread_memories CASCADE;
      DROP TABLE IF EXISTS bread_documents CASCADE;
      DROP TABLE IF EXISTS bread_embedding_widths CASCADE;
      DROP TABLE IF EXISTS bread_sessions CASCADE;
      DROP TABLE IF EXISTS bread_kg_nodes CASCADE;
    `)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

async function withAdmin<T>(fn: (admin: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const admin = postgres(pg.url, { max: 1, onnotice: () => {} })
  try {
    return await fn(admin)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

test('a missing journal is pending and migrate then skips 0001_baseline', async () => {
  await reset()
  const backend = store({ url: pg.url })
  try {
    await expect(backend.migrations?.()).rejects.toMatchObject({
      code: 'MIGRATIONS_PENDING',
      context: { reason: 'missing_journal' },
    })
    expect(await backend.migrate?.()).toEqual({ applied: ['0001_baseline'], skipped: [] })
    expect(await backend.migrations?.()).toEqual({ pending: [] })
    expect(await backend.migrate?.()).toEqual({ applied: [], skipped: ['0001_baseline'] })
  } finally {
    await backend.close?.()
  }
})

test('an existing schema adopts 0001 without dropping leftover bread_kg tables', async () => {
  await reset()
  await withAdmin(async (admin) => {
    await admin.unsafe(`CREATE TABLE bread_sessions (
      id TEXT PRIMARY KEY,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      agent_id TEXT,
      tags JSONB NOT NULL DEFAULT '{}'
    )`)
    await admin.unsafe('CREATE TABLE bread_kg_nodes (id TEXT)')
  })
  const backend = store({ url: pg.url })
  try {
    expect(await backend.migrate?.()).toEqual({ applied: ['0001_baseline'], skipped: [] })
  } finally {
    await backend.close?.()
  }
  await withAdmin(async (admin) => {
    const columns = await admin<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'bread_sessions' AND column_name = 'principal'`
    expect(columns).toHaveLength(1)
    const kg = await admin<Array<{ name: string | null }>>`SELECT to_regclass('public.bread_kg_nodes') AS name`
    expect(kg[0]?.name).toBe('bread_kg_nodes')
    const journal = await admin<Array<{ checksum: string }>>`
      SELECT checksum FROM bread_migrations WHERE id = '0001_baseline'`
    expect(journal[0]?.checksum).toBe(migrationChecksum(BASELINE_TEXT))
    const vector = await admin<Array<{ ext: string | null }>>`
      SELECT extname AS ext FROM pg_extension WHERE extname = 'vector'`
    expect(vector).toHaveLength(0)
  })
})

test('a changed checksum is not rewritten, a known vector id is tolerated, and an unknown id is ahead', async () => {
  await reset()
  const backend = store({ url: pg.url })
  try {
    await backend.migrate?.()
  } finally {
    await backend.close?.()
  }
  const wrong = 'ab'.repeat(32)
  await withAdmin(async (admin) => {
    await admin`UPDATE bread_migrations SET checksum = ${wrong} WHERE id = '0001_baseline'`
  })
  const changed = store({ url: pg.url })
  try {
    await expect(changed.migrations?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })
    await expect(changed.migrate?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })
  } finally {
    await changed.close?.()
  }
  await withAdmin(async (admin) => {
    const rows = await admin<Array<{ checksum: string }>>`
      SELECT checksum FROM bread_migrations WHERE id = '0001_baseline'`
    expect(rows[0]?.checksum).toBe(wrong)
    await admin`UPDATE bread_migrations SET checksum = ${migrationChecksum(BASELINE_TEXT)} WHERE id = '0001_baseline'`
    await admin`
      INSERT INTO bread_migrations (id, checksum, applied_at)
      VALUES (${VECTOR_ID}, ${'cd'.repeat(32)}, ${Date.now()})`
  })
  const known = store({ url: pg.url })
  try {
    expect(await known.migrations?.()).toEqual({ pending: [] })
  } finally {
    await known.close?.()
  }
  await withAdmin(async (admin) => {
    await admin`
      INSERT INTO bread_migrations (id, checksum, applied_at)
      VALUES ('0009_future', ${'ef'.repeat(32)}, ${Date.now()})`
  })
  const ahead = store({ url: pg.url })
  try {
    await expect(ahead.migrations?.()).rejects.toMatchObject({ code: 'MIGRATION_AHEAD' })
  } finally {
    await ahead.close?.()
  }
})

test('embed adds 0002_vector when the extension is available', async () => {
  const vectorPg = await withPglite({ vector: true })
  const backend = store({ url: vectorPg.url, embed: async () => [1, 0, 0] })
  try {
    const report = await backend.migrate?.()
    expect(report?.applied).toEqual(['0001_baseline', VECTOR_ID])
    expect(await backend.migrations?.()).toEqual({ pending: [] })
  } finally {
    await backend.close?.()
    await vectorPg.close()
  }
})
