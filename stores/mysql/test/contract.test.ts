import { afterAll, beforeAll } from 'bun:test'
import { store } from '@breadai/store-mysql'
import { runStoreContract } from '@breadai/test-utils'
import { startMysql, type MysqlFixture } from './harness.ts'

let fixture: MysqlFixture

beforeAll(async () => {
  fixture = await startMysql()
  const backend = store(fixture.opts)
  try {
    await backend.migrate?.()
  } finally {
    await backend.close?.()
  }
}, 300_000)

afterAll(async () => {
  await fixture?.stop()
})

runStoreContract('mysql', () => store(fixture.opts), {
  reset: async () => {
    await fixture.reset()
  },
})
