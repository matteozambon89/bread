import type { AgentRegistry, BreadConfig, BreadInstance, TaskRegistry } from '@breadai/core'
import { assertHttpAuth, createServer, httpAuthLoopbackWarning, type ServerOptions } from '@breadai/server'

/**
 * Bun listen adapter for `@breadai/server`.
 *
 * Builds the Hono app via `createServer`, then binds with `Bun.serve`.
 * Same opts shape (`port` / `host` / `idleTimeout` from opts or `config.server`,
 * falling back to port 3000 / host `localhost`).
 *
 * Do not import `@hono/node-server` from this package — its `serve()` permanently
 * breaks Bun.serve Response handling in the same process.
 */
export async function startServer(
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

  const server = Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
    ...(idleTimeout !== undefined ? { idleTimeout } : {}),
  })
  const stopServe = () => server.stop()

  console.log(`[bread] Listening on http://${host}:${port}`)

  return {
    bread,
    stop: async () => {
      await bread.stop()
      stopServe()
    },
  }
}
