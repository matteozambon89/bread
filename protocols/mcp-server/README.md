<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @bread/protocol-mcp-server

Expose bread agents, tasks, tools, and agent+skill combinations as
[Model Context Protocol](https://modelcontextprotocol.io) tools — over stdio (bread as an MCP
child process) or Streamable HTTP mounted on bread's own server at `/mcp`, gated by whatever
auth strategy the app configures.

```bash
bun add @bread/protocol-mcp-server   # or: npm i @bread/protocol-mcp-server
```

```ts
import { defineConfig } from '@bread/core'
import { mcpServer } from '@bread/protocol-mcp-server'

export default defineConfig({
  entrypoints: ['researcher'],
  plugins: [
    // List mcpServer last: its stdio transport snapshots other plugins' tools at init.
    mcpServer({
      transport: 'http', // or 'stdio' (default)
      agents: ['researcher'],
      tasks: ['extract'],
    }),
  ],
})
```

Exposed agents run via `bread.run(..., { mode: 'sync' })` with real input/output schemas; tasks
keep their full hook chain and crumbs.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [MCP server](https://github.com/matteozambon89/bread/blob/HEAD/docs/mcp-server.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
