import net from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import postgres from 'postgres'

export interface PgliteHandle {
  /** postgres:// URL pointing at the in-process pglite over its socket. */
  url: string
  /** Empties every bread_ table — call between contract cases for isolation. */
  truncate: () => Promise<void>
  /** Stops the socket server and closes the pglite instance. */
  close: () => Promise<void>
}

// All bread_ tables. CASCADE clears dependents (messages, loop iterations, edges, crumbs).
const TABLES = [
  'bread_sessions',
  'bread_checkpoints',
  'bread_loops',
  'bread_task_runs',
  'bread_crumbs',
  'bread_kg_nodes',
  'bread_documents',
].join(', ')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Starts an in-process Postgres (pglite, WASM) fronted by a socket server that
 * speaks the Postgres wire protocol, so `@breadai/store-postgres`'s `store({ url })` connects to it
 * unchanged — no external server, no Docker. An ephemeral port avoids collisions
 * between parallel test files.
 *
 * pglite is single-threaded and the socket server reliably serves only ONE
 * postgres.js connection at a time. So callers must keep just one connection
 * alive: close the store before calling `truncate` (which opens its own transient
 * client and ends it immediately). Direct `db.exec` is used only pre-start
 * (`ALTER DATABASE`) and post-stop (`close`), when no socket client exists.
 */
export async function withPglite(): Promise<PgliteHandle> {
  const db = new PGlite()
  await db.waitReady
  // Silence pglite's chatty DEBUG/NOTICE for every connection (before the socket
  // is up, so this direct exec can't race a socket client).
  await db.exec("ALTER DATABASE postgres SET client_min_messages = 'warning'")

  const port = await freePort()
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' })
  await server.start()

  const url = `postgres://postgres@127.0.0.1:${port}/postgres`

  return {
    url,
    // Transient client, opened and closed here, so it's the sole connection.
    truncate: async () => {
      const admin = postgres(url, { max: 1, onnotice: () => {} })
      try {
        await admin.unsafe(`TRUNCATE ${TABLES} CASCADE`)
      } finally {
        await admin.end({ timeout: 5 })
      }
    },
    close: async () => {
      await server.stop()
      await db.close()
    },
  }
}

