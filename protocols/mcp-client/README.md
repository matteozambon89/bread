<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/protocol-mcp-client

Consume [Model Context Protocol](https://modelcontextprotocol.io) servers from bread agents:
config-level `servers` (stdio or Streamable HTTP, with automatic legacy-SSE fallback) shared
across agents, plus per-agent inline `external` servers under `cfg.plugins.mcp_client`. Imported
tools are snake_case-sanitized, namespaced `<server>__<tool>`, permission-tagged
`plugin:mcp_client/…`, and auth-signed per request (expiring tokens refresh naturally).

```bash
bun add @breadai/protocol-mcp-client   # or: npm i @breadai/protocol-mcp-client
```

```ts
import { defineConfig } from '@breadai/core'
import { mcpClient } from '@breadai/protocol-mcp-client'

export default defineConfig({
  entrypoints: ['researcher'],
  plugins: [
    mcpClient({
      servers: [{ name: 'filesystem', command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '.'] }],
    }),
  ],
})
```

```ts
// agents/researcher/agent.ts — opt this agent into a server (or inline one):
plugins: { mcp_client: { servers: ['filesystem'] } }
```

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [MCP client](https://github.com/matteozambon89/bread/blob/HEAD/docs/mcp-client.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
