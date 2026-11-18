import { afterAll, beforeAll } from 'bun:test'
import { store } from '@breadai/store-mongodb'
import { runStoreContract } from '@breadai/test-utils'
import { startMongo, type MongoTest } from './harness.ts'

let mongo: MongoTest

beforeAll(async () => {
  mongo = await startMongo()
}, 180_000)

afterAll(async () => {
  await mongo?.close()
})

runStoreContract('mongodb', () => store({ url: mongo.url, loopback: true }), {
  reset: () => mongo.resetData(),
})
