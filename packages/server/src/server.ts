import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type {
  AgentRegistry,
  BreadAuthStrategy,
  BreadConfig,
  BreadInstance,
  BreadPlugin,
  TaskRegistry,
} from '@bread/core'
import { BreadError, createBread } from '@bread/core'

export interface ServerOptions {
  port?: number
  host?: string
  idleTimeout?: number
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024 // 1 MB

// What an HTTP client may see of an error: code + message only. Stack, cause,
// and context stay server-side (they can carry provider responses or paths).
function toClientError(err: unknown): { code: string; message: string } {
  if (err instanceof BreadError) return { code: err.code, message: err.message }
  if (err instanceof AggregateError) {
    return { code: 'AGGREGATE_ERROR', message: err.message || 'Multiple operations failed' }
  }
  return { code: 'INTERNAL_ERROR', message: 'Internal server error' }
}

// Server-side auth: a caller passes if at least one strategy authenticates the
// request; the resolved identity is stashed on the context. Not wired in
// automatically anywhere — attach it yourself via `authPlugin()` (or apply it
// to a Hono app directly) if you want it.
export function authMiddleware(strategies: BreadAuthStrategy[]): MiddlewareHandler {
  return async (c, next) => {
    for (const strategy of strategies) {
      const identity = await strategy.authenticate(c.req.raw)
      if (identity) {
        c.set('identity' as never, identity as never)
        return next()
      }
    }
    return c.json({ error: 'Unauthorized' }, 401)
  }
}

// Convenience wrapper: turns strategies into a BreadPlugin so they can be
// dropped straight into `config.plugins`, same as any other plugin.
export function authPlugin(strategies: BreadAuthStrategy[]): BreadPlugin {
  return {
    name: 'auth',
    middleware: (app) => {
      ;(app as Hono).use('*', authMiddleware(strategies))
    },
  }
}

export function createServer(
  config: BreadConfig,
  agents: AgentRegistry,
  tasks: TaskRegistry = new Map(),
): { bread: BreadInstance; app: Hono } {
  // `config.store` is the single source of truth — strict everywhere, no
  // interactive or auto-wired fallback.
  if (!config.store) {
    throw new BreadError(
      "No store configured. Set `store` in bread.config.ts — e.g. `store({ path: './bread.db' })` " +
        "from `@bread/store-sqlite`, or `store()` from `@bread/store-postgres` (reads DATABASE_URL).",
      'STORE_NOT_CONFIGURED',
    )
  }
  // `config.transport` is the single ingress seam — strict everywhere too, no
  // hardcoded default and no transport package as a hard dependency of
  // @bread/core/@bread/server/@bread/cli. Must be mount-capable (not every
  // BreadTransport is — @bread/transport-redis, for one, is fan-out only).
  if (!config.transport?.mount) {
    throw new BreadError(
      'No mount-capable transport configured. Set `transport` in bread.config.ts — e.g. ' +
        '`transport: transport()` from `@bread/transport-http-chunked` (or ' +
        '`@bread/transport-http-sse` for the SSE/browser-EventSource-friendly alternative).',
      'TRANSPORT_NOT_CONFIGURED',
    )
  }
  const bread = createBread(config, agents, tasks)
  const app = new Hono()

  // Body-size cap: applied globally, before any plugin middleware/routes and
  // before the transport mounts its streaming routes, so it covers every
  // request this app ever sees. Default 1 MB, override via
  // `config.server.maxBodyBytes`. Rate limiting / concurrency protection is
  // deliberately left to the operator — see docs/http-api.md#limits.
  app.use(
    '*',
    bodyLimit({
      maxSize: config.server?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body too large' } }, 413),
    }),
  )

  if (typeof config.store.getCrumbs !== 'function') {
    console.log(
      '[bread] Store lacks the crumb log (getCrumbs/appendCrumbs) — GET /runs/:runId/stream ' +
        'serves live frames only, without Last-Event-ID catch-up.',
    )
  }

  // Non-streaming routes: sanitized error shape on any uncaught throw.
  app.onError((err, c) => {
    console.error('[bread] Request failed:', err)
    return c.json({ error: toClientError(err) }, 500)
  })

  // Plugin-contributed middleware (e.g. @bread/server's authPlugin()) — applied
  // before any routes below, regardless of plugin registration order, so a
  // gate wraps everything downstream: this loop, the routes loop after it,
  // and the transport mount.
  for (const plugin of config.plugins ?? []) {
    plugin.middleware?.(app)
  }

  // Plugin-contributed HTTP routes (e.g. @bread/protocol-mcp-server's HTTP exposure).
  for (const plugin of config.plugins ?? []) {
    plugin.routes?.(app)
  }

  // The four streaming routes (run/pipeline-run/resume/passive-stream) are the
  // transport's job now — implemented generically against the public
  // BreadInstance surface by whichever @bread/transport-* package is mounted.
  config.transport.mount(app, bread)

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  // List agents
  app.get('/agents', (c) => {
    const list = [...agents.entries()].map(([id, def]) => ({
      id,
      model: def.config.model,
      outputFormat: def.config.output.format,
    }))
    return c.json(list)
  })

  // Agent schema
  app.get('/agents/:id', (c) => {
    const id = c.req.param('id')
    const def = agents.get(id)
    if (!def) return c.json({ error: `Agent "${id}" not found` }, 404)
    return c.json({
      id,
      model: def.config.model,
      outputFormat: def.config.output.format,
    })
  })

  // Sessions
  app.get('/sessions', async (c) => {
    const tag = c.req.query('tag')
    const tags = tag ? Object.fromEntries([tag.split(':')]) : undefined
    const list = await bread.store.listSessions(tags ? { tags } : undefined)
    return c.json(list)
  })

  app.get('/sessions/:id', async (c) => {
    const session = await bread.store.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json(session)
  })

  app.delete('/sessions/:id', async (c) => {
    await bread.store.deleteSession(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/sessions/cleanup', async (c) => {
    let body: { olderThanDays?: number; tags?: Record<string, string> } = {}
    try {
      body = await c.req.json()
    } catch {}
    // The HTTP body speaks days (docs/http-api.md); the store speaks ms.
    // Passing the body through unconverted silently dropped the time filter.
    const count = await bread.store.cleanupSessions({
      ...(typeof body.olderThanDays === 'number'
        ? { olderThanMs: body.olderThanDays * 24 * 60 * 60 * 1000 }
        : {}),
      ...(body.tags ? { tags: body.tags } : {}),
    })
    return c.json({ deleted: count })
  })

  // Loops (agent-driven). Listed/inspected for frontend reporting; live progress
  // arrives as loop:* crumbs on the agent run's SSE stream.
  app.get('/loops', async (c) => {
    const session = c.req.query('session')
    const agent = c.req.query('agent')
    const status = c.req.query('status')
    const filter = {
      ...(session ? { sessionId: session } : {}),
      ...(agent ? { agentId: agent } : {}),
      ...(status ? { status: status as never } : {}),
    }
    const list = await bread.store.listLoops(Object.keys(filter).length ? filter : undefined)
    return c.json(list)
  })

  app.get('/loops/:id', async (c) => {
    const loop = await bread.store.getLoop(c.req.param('id'))
    if (!loop) return c.json({ error: 'Loop not found' }, 404)
    return c.json(loop)
  })

  // Task runs (audit). Each one-shot task invocation is recorded for after-the-fact
  // review; live progress arrives as task:* crumbs on the agent run's SSE stream.
  app.get('/tasks', async (c) => {
    if (!bread.store.listTaskRuns) return c.json({ error: 'Store does not record task runs' }, 501)
    const task = c.req.query('task')
    const session = c.req.query('session')
    const agent = c.req.query('agent')
    const status = c.req.query('status')
    const limit = c.req.query('limit')
    const filter = {
      ...(task ? { taskId: task } : {}),
      ...(session ? { sessionId: session } : {}),
      ...(agent ? { agentId: agent } : {}),
      ...(status ? { status: status as never } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    }
    const list = await bread.store.listTaskRuns(Object.keys(filter).length ? filter : undefined)
    return c.json(list)
  })

  app.get('/tasks/:id', async (c) => {
    if (!bread.store.getTaskRun) return c.json({ error: 'Store does not record task runs' }, 501)
    const run = await bread.store.getTaskRun(c.req.param('id'))
    if (!run) return c.json({ error: 'Task run not found' }, 404)
    return c.json(run)
  })

  return { bread, app }
}

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
