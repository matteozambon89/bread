import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { migrationChecksum } from '@breadai/core'
import { MongoClient } from 'mongodb'
import { store } from '@breadai/store-mongodb'
import { BASELINE_ID, BASELINE_TEXT } from '../src/migrate.ts'
import { JOURNAL, LOCK, LOCK_ID, SESSIONS } from '../src/names.ts'
import { mongoClientOptions, resolveMongoUrl } from '../src/url.ts'
import { startMongo, type MongoTest } from './harness.ts'

let mongo: MongoTest

beforeAll(async () => {
  mongo = await startMongo()
}, 180_000)

afterAll(async () => {
  await mongo?.close()
})

beforeEach(async () => {
  await mongo.dropBread()
})

function backend() {
  return store({ url: mongo.url, loopback: true })
}

async function withClient<T>(fn: (db: import('mongodb').Db) => Promise<T>): Promise<T> {
  const endpoint = resolveMongoUrl(mongo.url, true)
  const client = new MongoClient(mongo.url, mongoClientOptions(endpoint, 1))
  try {
    await client.connect()
    return await fn(client.db())
  } finally {
    await client.close()
  }
}

test('a missing journal is pending and does not create the schema', async () => {
  const opened = backend()
  try {
    await expect(opened.migrations?.()).rejects.toMatchObject({
      code: 'MIGRATIONS_PENDING',
      context: { reason: 'missing_journal' },
    })
    await expect(opened.listSessions()).rejects.toMatchObject({ code: 'MIGRATIONS_PENDING' })
  } finally {
    await opened.close?.()
  }
  const names = await mongo.names()
  expect(names).not.toContain(JOURNAL)
  expect(names).not.toContain(SESSIONS)
})

test('migrate records 0001_baseline and a second call skips it', async () => {
  const opened = backend()
  try {
    expect(await opened.migrate?.()).toEqual({ applied: [BASELINE_ID], skipped: [] })
    expect(await opened.migrations?.()).toEqual({ pending: [] })
    expect(await opened.migrate?.()).toEqual({ applied: [], skipped: [BASELINE_ID] })
    expect(await opened.listSessions()).toEqual([])
  } finally {
    await opened.close?.()
  }
  await withClient(async (db) => {
    const row = await db.collection(JOURNAL).findOne({ _id: BASELINE_ID })
    expect(row?.checksum).toBe(migrationChecksum(BASELINE_TEXT))
  })
})

test('an existing schema adopts 0001 without dropping leftover bread_kg collections', async () => {
  await withClient(async (db) => {
    await db.createCollection(SESSIONS)
    await db.createCollection('bread_kg_nodes')
    await db.collection('bread_kg_nodes').insertOne({ _id: 'kept' })
  })
  const opened = backend()
  try {
    expect(await opened.migrate?.()).toEqual({ applied: [BASELINE_ID], skipped: [] })
    expect(await opened.listSessions()).toEqual([])
  } finally {
    await opened.close?.()
  }
  await withClient(async (db) => {
    const kept = await db.collection('bread_kg_nodes').findOne({ _id: 'kept' })
    expect(kept?._id).toBe('kept')
    const indexes = await db.collection(SESSIONS).indexes()
    expect(indexes.map((index) => index.name)).toContain('idx_bread_sessions_updated')
  })
})

test('a changed checksum is not rewritten and an unknown id is ahead', async () => {
  const opened = backend()
  try {
    await opened.migrate?.()
  } finally {
    await opened.close?.()
  }
  const wrong = 'ab'.repeat(32)
  await withClient(async (db) => {
    await db.collection(JOURNAL).updateOne({ _id: BASELINE_ID }, { $set: { checksum: wrong } })
  })
  const changed = backend()
  try {
    await expect(changed.migrations?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })
    await expect(changed.migrate?.()).rejects.toMatchObject({ code: 'MIGRATION_CHANGED' })
  } finally {
    await changed.close?.()
  }
  await withClient(async (db) => {
    const row = await db.collection(JOURNAL).findOne({ _id: BASELINE_ID })
    expect(row?.checksum).toBe(wrong)
    await db.collection(JOURNAL).updateOne({ _id: BASELINE_ID }, { $set: { checksum: migrationChecksum(BASELINE_TEXT) } })
    await db.collection(JOURNAL).insertOne({ _id: '0009_future', checksum: 'cd'.repeat(32), applied_at: Date.now() })
  })
  const ahead = backend()
  try {
    await expect(ahead.migrations?.()).rejects.toMatchObject({ code: 'MIGRATION_AHEAD' })
  } finally {
    await ahead.close?.()
  }
})

test('a held migration lock fails closed', async () => {
  await withClient(async (db) => {
    await db.collection(LOCK).insertOne({ _id: LOCK_ID, at: 1 })
  })
  const opened = backend()
  try {
    await expect(opened.migrations?.()).rejects.toMatchObject({ code: 'MIGRATION_LOCK' })
    await expect(opened.migrate?.()).rejects.toMatchObject({ code: 'MIGRATION_LOCK' })
  } finally {
    await opened.close?.()
  }
})

test('tag keys that fail the allowlist throw before a query', async () => {
  const opened = backend()
  try {
    await opened.migrate?.()
    await expect(opened.createSession({ tags: { $gt: '1' } })).rejects.toMatchObject({ code: 'INVALID_TAG' })
    await expect(opened.listSessions({ tags: { 'a.b': 'c' } })).rejects.toMatchObject({ code: 'INVALID_TAG' })
    await expect(opened.cleanupSessions({ olderThanMs: 1, tags: { constructor: 'no' } })).rejects.toMatchObject({
      code: 'INVALID_TAG',
    })
    expect(await opened.listSessions()).toEqual([])
  } finally {
    await opened.close?.()
  }
})

test('keyword search escapes regex metacharacters and bounds the limit', async () => {
  const opened = backend()
  try {
    await opened.migrate?.()
    await opened.ingestDocument?.({ agentId: 'a', title: 'a.b', content: '100%' })
    await opened.ingestDocument?.({ agentId: 'a', title: 'axb', content: 'plain' })
    const dotted = await opened.searchDocuments?.({ agentId: 'a', query: '.' })
    expect(dotted?.map((doc) => doc.title)).toEqual(['a.b'])
    const percent = await opened.searchDocuments?.({ agentId: 'a', query: '%' })
    expect(percent?.map((doc) => doc.title)).toEqual(['a.b'])
    await expect(opened.searchDocuments?.({ agentId: 'a', query: 'a', limit: 1001 })).rejects.toMatchObject({
      code: 'INVALID_LIMIT',
    })
    await expect(opened.searchMemories?.({
      agentId: 'a',
      principal: { iss: 'https://idp.example', sub: 'ada' },
      query: 'x',
      limit: 1.5,
    })).rejects.toMatchObject({ code: 'INVALID_LIMIT' })
  } finally {
    await opened.close?.()
  }
})
