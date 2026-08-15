import type { BreadSigner, ToolDefinition } from '@bread/core'
import { type ConnectedServer, connectServer } from './client.js'

// Inline per-agent MCP server, declared directly on an agent's own config
// (as opposed to `servers`, which names one of the plugin-level servers
// connected once at `init()`). Deliberately http-only — a smaller trust
// surface than `servers`, which can spawn a local process and is set once,
// centrally, in `bread.config.ts`.
export interface McpExternalServerConfig {
  name: string
  url: string
  headers?: Record<string, string>
}

function headersSigner(headers: Record<string, string>): BreadSigner {
  return {
    name: 'external_mcp_static_headers',
    sign(h) {
      for (const [key, value] of Object.entries(headers)) h.set(key, value)
    },
  }
}

// Connects (and caches) `external` server configs on demand, keyed by
// `name::url` — not by config-object identity, since config objects aren't
// guaranteed referentially stable across a hot reload or a hand-built agent
// registry. A failed connect's cache entry is dropped so the next call
// retries instead of permanently caching the failure.
export function createExternalConnectionCache(): {
  resolve: (cfg: McpExternalServerConfig) => Promise<ConnectedServer>
  destroy: () => Promise<void>
} {
  const cache = new Map<string, Promise<ConnectedServer>>()

  function resolve(cfg: McpExternalServerConfig): Promise<ConnectedServer> {
    const key = `${cfg.name}::${cfg.url}`
    let pending = cache.get(key)
    if (!pending) {
      pending = connectServer({
        name: cfg.name,
        transport: 'http',
        url: cfg.url,
        ...(cfg.headers ? { signer: headersSigner(cfg.headers) } : {}),
      })
      cache.set(key, pending)
      pending.catch(() => cache.delete(key))
    }
    return pending
  }

  async function destroy(): Promise<void> {
    for (const pending of cache.values()) {
      await pending.then((s) => s.close()).catch(() => {})
    }
    cache.clear()
  }

  return { resolve, destroy }
}

// Every tool coming out of an mcp-client-resolved server is name-mangled with
// its source server, so two servers under one agent can't collide even if
// they happen to expose a same-named tool (the leaf they land under is a
// single flat `plugin:mcp_client/<name>` namespace, unlike a per-server sub).
export function namespaced(serverName: string, def: ToolDefinition): ToolDefinition {
  return { ...def, name: `${serverName}__${def.name}` }
}
