import { afterAll, beforeAll } from 'bun:test'
import { store } from '@breadai/store-postgres'
import { type PgliteHandle, runStoreContract, withPglite } from '@breadai/test-utils'

// Hermetic Postgres: an in-process pglite (real Postgres in WASM) behind a socket
// server speaking the wire protocol, so `store({ url })` connects to it
// unchanged — no server, no Docker. Set BREAD_TEST_DATABASE_URL to point at a
// real (disposable) database instead.
//
// One pglite is shared across cases; the contract opens a fresh store per case,
// closes it, then TRUNCATEs — pglite serves one connection at a time, so cases
// never overlap.
const realUrl = process.env.BREAD_TEST_DATABASE_URL

let pg: PgliteHandle | undefined
let url: string

beforeAll(async () => {
  url = realUrl ?? (pg = await withPglite()).url
  // Create the schema once; per-case close + TRUNCATE keeps cases isolated.
  const testStore = store({ url })
  await testStore.migrate?.()
  await testStore.close?.()
})

afterAll(async () => {
  await pg?.close()
})

runStoreContract('postgres', () => store({ url }), {
  reset: async () => {
    if (pg) await pg.truncate()
  },
})
