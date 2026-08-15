import type { AgentConfig, BreadPlugin, ToolDefinition } from '@breadai/core'
import { type ConnectedServer, type McpServerConfig, connectServer } from './client.js'
import { type McpExternalServerConfig, createExternalConnectionCache, namespaced } from './external.js'

export type { McpServerConfig, ConnectedServer } from './client.js'
export type { McpExternalServerConfig } from './external.js'
export { connectServer, sanitizeMcpToolName } from './client.js'
export { jsonSchemaToZod } from './json-schema-to-zod.js'

export interface McpClientOptions {
  /** Servers connected once, at plugin init, shared across every agent. */
  servers?: McpServerConfig[]
}

// The shape an agent writes under `cfg.plugins.mcp_client` — opaque to core,
// meaningful only to this plugin.
export interface McpClientAgentConfig {
  /** Names of `McpClientOptions.servers` this agent may call. */
  servers?: string[]
  /** Inline per-agent servers, connected lazily and cached by `name`+`url`. */
  external?: McpExternalServerConfig[]
}

/**
 * MCP client plugin. Connects every `servers` entry once at `init()`, and
 * implements `resolveAgentTools` so any agent that declares
 * `cfg.plugins.mcp_client` (naming one of those servers, or an inline
 * `external` one) gets that server's tools merged into its own tool set,
 * tagged `plugin:mcp_client/<name>` like any other plugin's tools.
 */
export function mcpClient(opts: McpClientOptions = {}): BreadPlugin {
  const connected: ConnectedServer[] = []
  const external = createExternalConnectionCache()

  return {
    name: 'mcp_client',
    async init() {
      for (const cfg of opts.servers ?? []) connected.push(await connectServer(cfg))
    },
    async resolveAgentTools(agentId, cfg: AgentConfig<unknown, unknown>): Promise<ToolDefinition[]> {
      const agentCfg = cfg.plugins?.mcp_client as McpClientAgentConfig | undefined
      if (!agentCfg) return []

      const tools: ToolDefinition[] = []

      for (const name of agentCfg.servers ?? []) {
        const server = connected.find((s) => s.name === name)
        if (!server) {
          throw new Error(
            `agent "${agentId}": mcp_client server "${name}" is not configured — ` +
              `pass it to mcpClient({servers: [...]}) at the top-level bread.config.ts`,
          )
        }
        tools.push(...server.tools.map((t) => namespaced(server.name, t)))
      }

      for (const ext of agentCfg.external ?? []) {
        const server = await external.resolve(ext)
        tools.push(...server.tools.map((t) => namespaced(server.name, t)))
      }

      return tools
    },
    async close() {
      await external.destroy()
      for (const server of connected) {
        await server.close().catch(() => {})
      }
    },
  }
}
