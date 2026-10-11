import type { Server as HttpServer } from 'node:http'
import type { AgentRegistry, BreadConfig, BreadInstance, TaskRegistry } from '@breadai/core'
import { assertHttpAuth, createServer, httpAuthLoopbackWarning, type ServerOptions } from '@breadai/server'
import { serve } from '@hono/node-server'

/**
 * Same opts shape (`port` / `host` / `idleTimeout` from opts or `config.server`,
 * falling back to port 3000 / host `localhost`). Container hosts often pass
 * `{ host: '0.0.0.0', port: 8080 }` — those are not the defaults here, so local
 * use stays aligned with Bun `startServer`.
 *
 * `idleTimeout` (seconds, same as Bun.serve) maps to Node `server.timeout` in ms
 * when set; omit it to keep Node's default socket timeout.
 *
 * Production source has no `bun:*` imports — listen is `@hono/node-server` only.
 */
export async function startServerNode(
  config: BreadConfig,
  agents: AgentRegistry,
  opts: ServerOptions = {},
  tasks: TaskRegistry = new Map(),
): Promise<{ bread: BreadInstance; stop: () => Promise<void> }> {
  const port = opts.port ?? config.server?.port ?? 3000
  const host = opts.host ?? config.server?.host ?? 'localhost'
  const idleTimeout = opts.idleTimeout ?? config.server?.idleTimeout

  // A client can spoof Host. No auth listens only on loopback, and warns.
  // Every other combination throws before the socket opens.
  assertHttpAuth(config, host)
  const loopbackWarning = httpAuthLoopbackWarning(config, host)
  if (loopbackWarning) console.warn(loopbackWarning)

  const { bread, app } = createServer(config, agents, tasks)
  await bread.start()

  // @hono/node-server defaults to overrideGlobalObjects: true, which replaces
  // globalThis.Request/Response with lightweight polyfills. That is fine on a
  // dedicated Node process, but under Bun (our monorepo test runner, or any
  // mixed Bun.serve + node-server process) it poisons native fetch: responses
  // become "Response (lightweight)" with content-type text/plain, breaking
  // Bun.serve, MCP SDK CLIENT_HTTP_UNEXPECTED_CONTENT, and transport tests for
  // every subsequent file in the same process. Keep the platform Response.
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
    overrideGlobalObjects: false,
  }) as HttpServer

  if (idleTimeout !== undefined) {
    // serve() returns http.Server | Http2Server; both expose `timeout` (ms).
    // Bun.serve idleTimeout is seconds — convert to match that API.
    server.timeout = idleTimeout * 1000
  }

  // serve() returns before `listening`. Log and resolve only after the bind
  // succeeds so a caller can catch EADDRINUSE instead of hanging.
  try {
    await waitForListen(server)
  } catch (err) {
    await bread.stop()
    throw err
  }

  console.log(`[bread] Listening on http://${host}:${port}`)

  return {
    bread,
    stop: async () => {
      try {
        await bread.stop()
      } finally {
        // An open GET /runs/:runId/stream keeps the socket up; close() would
        // then wait forever and the port stays taken.
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            // Bun's closeAllConnections() already drops the handle (listening
            // becomes false). Node leaves it up, so close() must still run.
            if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err)
            else resolve()
          })
        })
      }
    },
  }
}

function waitForListen(server: HttpServer): Promise<void> {
  if (server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    server.once('listening', onListening)
    server.once('error', onError)
  })
}
