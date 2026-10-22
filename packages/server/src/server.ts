import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type {
  AgentRegistry,
  AuthIdentity,
  BreadAuthStrategy,
  BreadConfig,
  BreadInstance,
  BreadPlugin,
  TaskRegistry,
} from '@breadai/core'
import {
  attachVerifiedPeer,
  BreadError,
  createBread,
  HTTP_ACTIONS,
  isLoopbackHostname,
  matchHttpRoute,
  registerHttpRoute,
  verifiedPeer,
} from '@breadai/core'
import { hasAuthPlugin } from './http-auth.js'

export interface ServerOptions {
  port?: number
  host?: string
  idleTimeout?: number
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024 // 1 MB

type AuthEnv = { Variables: { identity: AuthIdentity } }

// What an HTTP client may see of an error: code + message only. Stack, cause,
// and context stay server-side (they can carry provider responses or paths).
function toClientError(err: unknown): { code: string; message: string } {
  if (err instanceof BreadError) return { code: err.code, message: err.message }
  if (err instanceof AggregateError) {
    return { code: 'AGGREGATE_ERROR', message: err.message || 'Multiple operations failed' }
  }
  return { code: 'INTERNAL_ERROR', message: 'Internal server error' }
}

// Stashes the authenticated identity. Only a plugin named `auth` (`authPlugin`)
// makes the HTTP grant call `server.authorize`. Applying this middleware by
// hand does not.
export function authMiddleware(strategies: BreadAuthStrategy[]): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    for (const strategy of strategies) {
      const identity = await strategy.authenticate(c.req.raw)
      if (identity) {
        c.set('identity', identity)
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
      ;(app as Hono<AuthEnv>).use('*', authMiddleware(strategies))
    },
  }
}


// Raw Host header wins. app.request() omits that forbidden header, so use the
// URL authority as written — WHATWG rewrites 127.1 to 127.0.0.1.
// X-Forwarded-Host is not read; a client can set it.
function requestHost(header: string | undefined, url: string): string | null {
  if (header) return header
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)
  return match?.[1] ?? null
}

function routeArgs(url: URL, params: Record<string, string>): Record<string, string> {
  // Path params win. A null prototype keeps a query key off Object.prototype.
  const args: Record<string, string> = Object.create(null)
  for (const [key, value] of url.searchParams) {
    if (!(key in args)) args[key] = value
  }
  for (const [key, value] of Object.entries(params)) args[key] = value
  return args
}

function register(app: Hono<AuthEnv>, method: string, path: string, action: string): void {
  registerHttpRoute(app, { method, path, action })
}

function httpGrant(config: BreadConfig, app: Hono<AuthEnv>): MiddlewareHandler<AuthEnv> {
  const authOn = hasAuthPlugin(config)
  return async (c, next) => {
    if (!authOn) {
      const host = requestHost(c.req.header('host'), c.req.url)
      if (!isLoopbackHostname(host)) return c.json({ error: 'Forbidden' }, 403)
      return next()
    }
    let url: URL
    try {
      url = new URL(c.req.url)
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const matched = matchHttpRoute(app, c.req.method, url.pathname)
    // An unregistered route has no action. Fail closed once auth is on.
    if (!matched) return c.json({ error: 'Forbidden' }, 403)
    const identity = c.get('identity')
    const authorize = config.server?.authorize
    const allowed =
      typeof authorize === 'function'
        ? await authorize(identity, matched.action, routeArgs(url, matched.params))
        : undefined
    if (allowed !== true) return c.json({ error: 'Forbidden' }, 403)
    return next()
  }
}

function limitedBody(maxSize: number): MiddlewareHandler<AuthEnv> {
  const limit = bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body too large' } }, 413),
  })
  return async (c, next) => {
    const peer = verifiedPeer(c.req.raw)
    return limit(c, async () => {
      // Counting a chunked body replaces the Request and drops the WeakMap.
      if (peer) attachVerifiedPeer(c.req.raw, peer)
      await next()
    })
  }
}

export function createServer(
  config: BreadConfig,
  agents: AgentRegistry,
  tasks: TaskRegistry = new Map(),
): { bread: BreadInstance; app: Hono<AuthEnv> } {
  // `config.store` is the single source of truth — strict everywhere, no
  // interactive or auto-wired fallback.
  if (!config.store) {
    throw new BreadError(
      "No store configured. Set `store` in bread.config.ts — e.g. `store({ path: './bread.db' })` " +
        "from `@breadai/store-sqlite`, or `store()` from `@breadai/store-postgres` (reads DATABASE_URL).",
      'STORE_NOT_CONFIGURED',
    )
  }
  // `config.transport` is the single ingress seam — strict everywhere too, no
  // hardcoded default and no transport package as a hard dependency of
  // @breadai/core/@breadai/server/@breadai/cli. Must be mount-capable (not every
  // BreadTransport is — @breadai/transport-redis, for one, is fan-out only).
  if (!config.transport?.mount) {
    throw new BreadError(
      'No mount-capable transport configured. Set `transport` in bread.config.ts — e.g. ' +
        '`transport: transport()` from `@breadai/transport-http-chunked` (or ' +
        '`@breadai/transport-http-sse` for the SSE/browser-EventSource-friendly alternative).',
      'TRANSPORT_NOT_CONFIGURED',
    )
  }
  const bread = createBread(config, agents, tasks)
  const app = new Hono<AuthEnv>()

  // Body-size cap: applied globally, before any plugin middleware/routes and
  // before the transport mounts its streaming routes, so it covers every
  // request this app ever sees. Default 1 MB, override via
  // `config.server.maxBodyBytes`. Rate limiting / concurrency protection is
  // deliberately left to the operator — see docs/http-api.md#limits.
  app.use('*', limitedBody(config.server?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES))

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

  // Plugin-contributed middleware (e.g. @breadai/server's authPlugin()) — applied
  // before any routes below, regardless of plugin registration order, so a
  // gate wraps everything downstream: this loop, the routes loop after it,
  // and the transport mount.
  for (const plugin of config.plugins ?? []) {
    plugin.middleware?.(app)
  }

  // After plugin middleware, before plugin routes, transport mount, and these routes.
  app.use('*', httpGrant(config, app))

  // Plugin-contributed HTTP routes (e.g. @breadai/protocol-mcp-server's HTTP exposure).
  for (const plugin of config.plugins ?? []) {
    plugin.routes?.(app)
  }

  // The four streaming routes (run/pipeline-run/resume/passive-stream) are the
  // transport's job now — implemented generically against the public
  // BreadInstance surface by whichever @breadai/transport-* package is mounted.
  config.transport.mount(app, bread)

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  // List agents
  register(app, 'GET', '/agents', HTTP_ACTIONS.agentList)
  app.get('/agents', (c) => {
    const list = [...agents.entries()].map(([id, def]) => ({
      id,
      model: def.config.model,
      outputFormat: def.config.output.format,
    }))
    return c.json(list)
  })

  // Agent schema
  register(app, 'GET', '/agents/:id', HTTP_ACTIONS.agentRead)
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
  register(app, 'GET', '/sessions', HTTP_ACTIONS.sessionList)
  app.get('/sessions', async (c) => {
    const tag = c.req.query('tag')
    const tags = tag ? Object.fromEntries([tag.split(':')]) : undefined
    const list = await bread.store.listSessions(tags ? { tags } : undefined)
    return c.json(list)
  })

  register(app, 'GET', '/sessions/:id', HTTP_ACTIONS.sessionRead)
  app.get('/sessions/:id', async (c) => {
    const session = await bread.store.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json(session)
  })

  register(app, 'DELETE', '/sessions/:id', HTTP_ACTIONS.sessionDelete)
  app.delete('/sessions/:id', async (c) => {
    await bread.store.deleteSession(c.req.param('id'))
    return c.json({ ok: true })
  })

  register(app, 'POST', '/sessions/cleanup', HTTP_ACTIONS.sessionCleanup)
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
  register(app, 'GET', '/loops', HTTP_ACTIONS.loopList)
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

  register(app, 'GET', '/loops/:id', HTTP_ACTIONS.loopRead)
  app.get('/loops/:id', async (c) => {
    const loop = await bread.store.getLoop(c.req.param('id'))
    if (!loop) return c.json({ error: 'Loop not found' }, 404)
    return c.json(loop)
  })

  // Task runs (audit). Each one-shot task invocation is recorded for after-the-fact
  // review; live progress arrives as task:* crumbs on the agent run's SSE stream.
  register(app, 'GET', '/tasks', HTTP_ACTIONS.taskList)
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

  register(app, 'GET', '/tasks/:id', HTTP_ACTIONS.taskRead)
  app.get('/tasks/:id', async (c) => {
    if (!bread.store.getTaskRun) return c.json({ error: 'Store does not record task runs' }, 501)
    const run = await bread.store.getTaskRun(c.req.param('id'))
    if (!run) return c.json({ error: 'Task run not found' }, 404)
    return c.json(run)
  })

  return { bread, app }
}
