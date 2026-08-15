# MCP server — `@breadai/protocol-mcp-server`

Expose selected bread agents, tasks, tools, and agent+skill combinations as
[Model Context Protocol](https://modelcontextprotocol.io) tools, over stdio or Streamable HTTP, built
on the official `@modelcontextprotocol/sdk`.

```bash
bun add @breadai/protocol-mcp-server
```

## Exposing agents and skills

```ts
import { mcpServer } from '@breadai/protocol-mcp-server'

mcpServer({
  transport: 'stdio',
  agents: ['researcher', 'writer'],
  skills: [{ agent: 'researcher', skill: 'deep_research' }],
})
```

Each exposed agent becomes an MCP tool that runs it via `bread.run(..., { mode: 'sync' })` — the
model decides what happens, same as any other run. Skills are exposed as `<agent>__<skill>`, running
that agent with the skill pre-selected. Both get the agent's **real** `inputSchema`/`outputSchema`
translated to the tool's MCP schema (a `z.object(...)` schema passes straight through; anything else
is wrapped as `{ input: ... }` / `{ output: ... }` so the tool stays spec-compliant) — an MCP client
listing tools sees the actual shape, not a generic `{ input: string }`.

## Exposing tasks

```ts
mcpServer({ tasks: ['summarize_document'] })
```

A task id is resolved from the task registry and run via `bread.runTask` — the same
`createTaskTool` compilation `cfg.tasks` uses for an agent, so the full `beforeRun`/`afterRun`/
`onError` hook chain and `TaskRunRecord` audit apply. Unlike a task called mid-agent-run, this
call has no host run stream to attach crumbs to, so it's deliberately crumb-silent: no
`task:start`/`task:end` crumbs are emitted.

## Exposing tools directly

```ts
mcpServer({
  tools: [
    'search',                        // a bare name — a plugin-contributed tool
    { agent: 'researcher', tool: 'fetch_page' },  // an agent-owned tool
  ],
})
```

A bare string names a tool from some plugin's static `tools` (matched against `ctx.pluginTools`); an
`{ agent, tool }` pair names one tool from that agent's own `agents/<id>/tools/*.ts`. Either way, the
call invokes that tool's `execute()` **directly — there is no model in the loop.** This is the one
place mcp-server takes a real shortcut, worth calling out precisely:

> **Ordering caveat (stdio only):** the stdio transport snapshots `ctx.pluginTools` when it builds
> its MCP server at `init()`, and plugins initialize in `config.plugins` registration order — so a
> bare-name tool owned by a plugin listed *after* `mcpServer` won't be found. List `mcpServer`
> **last** in `config.plugins`. The HTTP transport builds per request and is immune.

- Credential scoping still applies exactly as it would through a normal run (the same
  `def.credentials`/`credentialProvider` allowlist, via `buildToolCredentials`).
- `ctx.blobStore` is passed through when `config.blobStore` is set, same as a tool called through a
  normal run — store a generated/derived file and echo the resulting `uri` as this tool's output.
- `ToolDefinition.hooks` (its own `beforeRun`/`afterRun`/`onError`) and the `tool:call`/`tool:result`
  crumbs a real run would emit are **not** produced — there's no run to attach them to. If you need
  those, wrap the tool in a task or a minimal single-tool agent instead of exposing it directly.

## Transports and auth

- **`transport: 'stdio'`** (default) — connects one persistent MCP stdio server on `init()`. Use this
  when bread itself is launched as an MCP child process. There is no meaningful auth layer here by
  design: stdio is a local process pipe, and the OS process boundary *is* the trust boundary, the same
  as any other local CLI access.
- **`transport: 'http'`** — mounts a stateless Streamable HTTP endpoint on bread's own Hono app at
  `path` (default `/mcp`), via the plugin's `routes` hook — a fresh MCP server per request, same
  pattern the SDK itself documents for stateless serving.

The HTTP route needs **no auth code of its own**. `createServer()` runs every plugin's `middleware`
hook before any plugin's `routes()` are mounted, so if you've wired an auth plugin (e.g.
`authPlugin(...)` from [auth.md](./auth.md)), `/mcp` is gated exactly like every other route — with
no special-casing on mcp-server's part. Bread itself applies no default posture; add auth only if
you want it. Connect with the SDK's `StreamableHTTPClientTransport`.

## Building blocks

```ts
import { buildMcpServer, serveStdio, handleHttpRequest } from '@breadai/protocol-mcp-server'
```

`mcpServer(expose)` is a thin plugin wrapper around these — reach for them directly only if you need
a custom mount point or transport bread's Hono integration doesn't cover.
