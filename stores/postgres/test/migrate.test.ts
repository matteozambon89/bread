import { expect, test } from 'bun:test'
import postgres from 'postgres'
import { store } from '@breadai/store-postgres'
import { withPglite } from '@breadai/test-utils'

// Empty database on purpose. BREAD_TEST_DATABASE_URL may already have tables,
// which would hide VECTOR running before CREATE TABLE.
test('migrate creates bread_documents before the vector extension', async () => {
  const pg = await withPglite()
  const backend = store({
    url: pg.url,
    embed: async () => [1, 2, 3],
  })
  try {
    try {
      await backend.migrate?.()
    } catch {
      // pglite has no pgvector. The extension may fail after the tables exist.
    }
  } finally {
    await backend.close?.()
  }

  const admin = postgres(pg.url, { max: 1, onnotice: () => {} })
  try {
    const rows = await admin<
      Array<{ documents: string | null; memories: string | null; nodes: string | null; widths: string | null }>
    >`
      SELECT to_regclass('public.bread_documents') AS documents,
             to_regclass('public.bread_memories') AS memories,
             to_regclass('public.bread_kg_nodes') AS nodes,
             to_regclass('public.bread_embedding_widths') AS widths`
    expect(rows[0]?.documents).toBe('bread_documents')
    expect(rows[0]?.memories).toBe('bread_memories')
    expect(rows[0]?.nodes).toBeNull()
    expect(rows[0]?.widths).toBe('bread_embedding_widths')
  } finally {
    await admin.end({ timeout: 5 })
    await pg.close()
  }
})
