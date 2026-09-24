import type {
  AgentRegistry,
  BreadConfig,
  BreadInstance,
  TaskRegistry,
} from '@breadai/core'
import { createServer, type ServerOptions } from '@breadai/server'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// Not a security control — the framework still won't guess an auth policy for
// you (that stays the consumer's job, per the 2026-07-05 decision). This is
// deliberately loud and deliberately not a gate: it can't know whether any
// registered plugin's middleware actually *is* an auth check, only that at
// least one plugin hooked into the middleware chain at all, so a false
// negative (silence when auth *is* configured via some other means) is
// possible — the warning is a floor, not a guarantee.
function warnIfUnguardedNonLoopback(host: string, config: BreadConfig): void {
  if (LOOPBACK_HOSTS.has(host)) return
  const hasMiddleware = (config.plugins ?? []).some((p) => typeof p.middleware === 'function')
  if (hasMiddleware) return
  console.warn(
    `[bread] WARNING: binding to "${host}" (not loopback) with no plugin middleware registered. ` +
      'Every route — including agent runs and the passive run stream — is reachable by anyone who can ' +
      'reach this host. Add authPlugin([...]) (or your own BreadPlugin.middleware) before exposing this ' +
      'outside your machine. See docs/auth.md#guarding-the-server.',
  )
}

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

  warnIfUnguardedNonLoopback(host, config)

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
