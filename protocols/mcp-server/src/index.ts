import type { BreadInstance, BreadPlugin } from '@breadai/core'
import { type ExposeConfig, buildMcpServer, handleHttpRequest, serveStdio } from './server.js'

export type { ExposeConfig, McpBread } from './server.js'
export { buildMcpServer, serveStdio, handleHttpRequest } from './server.js'

// Minimal shape of the Hono app passed to BreadPlugin.routes — avoids a hono dep.
interface MinimalApp {
  all(
    path: string,
    handler: (c: { req: { raw: Request } }) => Response | Promise<Response>,
  ): unknown
}

/**
 * MCP server plugin. Exposes the agents/skills/tasks/tools named in `expose`
 * over MCP, either as a persistent stdio connection (default) or mounted at
 * an HTTP path on the bread server's own Hono app. The HTTP route rides
 * through bread's existing global auth gate automatically — this plugin adds
 * no auth logic of its own, and needs none.
 */
export function mcpServer(expose: ExposeConfig = {}): BreadPlugin {
  let breadRef: BreadInstance | null = null

  return {
    name: 'mcp_server',
    async init(bread) {
      breadRef = bread as unknown as BreadInstance
      // stdio exposure connects here; http exposure is mounted via routes().
      if (expose.transport !== 'http') {
        await serveStdio(buildMcpServer(breadRef, expose))
      }
    },
    routes(app) {
      if (expose.transport !== 'http') return
      const path = expose.path ?? '/mcp'
      // Stateless transport: build a fresh server + transport per request. By
      // the time requests arrive, init() has run and breadRef is set.
      ;(app as MinimalApp).all(path, async (c) => {
        if (!breadRef) return new Response('bread not started', { status: 503 })
        return handleHttpRequest(buildMcpServer(breadRef, expose), c.req.raw)
      })
    },
  }
}
