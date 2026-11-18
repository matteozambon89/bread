import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { DATA_COLLECTIONS, LOCK } from '../src/names.ts'
import { mongoClientOptions, resolveMongoUrl } from '../src/url.ts'

export interface MongoTest {
  url: string
  close: () => Promise<void>
  resetData: () => Promise<void>
  dropBread: () => Promise<void>
  names: () => Promise<string[]>
}

function assertDisposable(raw: string): void {
  try {
    resolveMongoUrl(raw, true)
  } catch {
    throw new Error('MongoDB test server must be a loopback URL without credentials.')
  }
  const start = raw.indexOf('://')
  const rest = start === -1 ? raw : raw.slice(start + 3)
  const at = rest.indexOf('@')
  if (at !== -1) throw new Error('MongoDB test server must not include credentials.')
}

async function withClient<T>(url: string, fn: (client: MongoClient) => Promise<T>): Promise<T> {
  const endpoint = resolveMongoUrl(url, true)
  const client = new MongoClient(url, mongoClientOptions(endpoint, 1))
  try {
    await client.connect()
    return await fn(client)
  } finally {
    await client.close()
  }
}

export async function startMongo(): Promise<MongoTest> {
  const fromEnv = process.env.MONGODB_URL
  let url: string
  let stop = async (): Promise<void> => {}
  if (fromEnv !== undefined && fromEnv !== '') {
    assertDisposable(fromEnv)
    url = fromEnv
  } else {
    let server: MongoMemoryServer
    try {
      server = await MongoMemoryServer.create({
        instance: {
          ip: '127.0.0.1',
          dbName: 'bread',
          args: ['--nounixsocket'],
        },
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      throw new Error(`MongoDB test server failed to start. ${reason}`)
    }
    url = server.getUri('bread')
    assertDisposable(url)
    stop = async () => {
      await server.stop()
    }
  }

  return {
    url,
    close: stop,
    resetData: () =>
      withClient(url, async (client) => {
        const db = client.db()
        for (const name of DATA_COLLECTIONS) await db.collection(name).deleteMany({})
        await db.collection(LOCK).deleteMany({})
      }),
    dropBread: () =>
      withClient(url, async (client) => {
        const db = client.db()
        const listed = await db.listCollections({}, { nameOnly: true }).toArray()
        for (const entry of listed) {
          if (!entry.name.startsWith('bread_')) continue
          await db.collection(entry.name).drop()
        }
      }),
    names: () =>
      withClient(url, async (client) => {
        const listed = await client.db().listCollections({}, { nameOnly: true }).toArray()
        return listed.map((entry) => entry.name)
      }),
  }
}
