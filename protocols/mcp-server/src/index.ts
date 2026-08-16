import type { BreadInstance, BreadPlugin } from '@breadai/core'
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation } from '@modelcontextprotocol/hono'
import type { McpHttpHandler } from '@modelcontextprotocol/server'
import type { Hono } from 'hono'
import { type ExposeConfig, buildMcpHttpHandler, buildMcpServer, serveStdio } from './server.js'

export type { ExposeConfig, McpBread } from './server.js'
export { buildMcpServer, buildMcpHttpHandler, serveStdio } from './server.js'

/**
 * MCP server plugin. Exposes the agents/skills/tasks/tools named in `expose`
 * over MCP, either as a persistent stdio connection (default) or mounted at
 * an HTTP path on the bread server's own Hono app. The HTTP route rides
 * through bread's existing global auth gate automatically — this plugin adds
 * no auth logic of its own, and needs none. It does add Host/Origin
 * DNS-rebinding protection (`expose.allowedHosts`, defaulting to
 * localhost-only) since that's a distinct concern from authentication and the
 * SDK ships it for free.
 */
export function mcpServer(expose: ExposeConfig = {}): BreadPlugin {
  let breadRef: BreadInstance | null = null
  let httpHandler: McpHttpHandler | null = null

  return {
    name: 'mcp_server',
    async init(bread) {
      breadRef = bread as unknown as BreadInstance
      if (expose.transport === 'http') {
        httpHandler = buildMcpHttpHandler(breadRef, expose)
      } else {
        // stdio connects here; http exposure is mounted via middleware()/routes().
        await serveStdio(breadRef, expose)
      }
    },
    middleware(app) {
      if (expose.transport !== 'http') return
      const path = expose.path ?? '/mcp'
      const hosts = expose.allowedHosts
      ;(app as Hono).use(path, hosts ? hostHeaderValidation(hosts) : localhostHostValidation())
      ;(app as Hono).use(path, hosts ? originValidation(hosts) : localhostOriginValidation())
    },
    routes(app) {
      if (expose.transport !== 'http') return
      const path = expose.path ?? '/mcp'
      // Built once in init() — createMcpHandler serves both the 2025-11-25
      // and 2026-07-28 wire formats from the same stateless handler.
      ;(app as Hono).all(path, async (c) => {
        if (!httpHandler) return new Response('bread not started', { status: 503 })
        return httpHandler.fetch(c.req.raw)
      })
    },
    // Unlike v1's per-request-disposable transport, the dual-era handler is
    // genuinely stateful (an in-process event bus, possibly open
    // subscriptions/listen streams) — close it on bread.stop() or it leaks.
    async close() {
      await httpHandler?.close()
    },
  }
}
