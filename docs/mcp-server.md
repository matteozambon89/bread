# MCP server — `@breadai/protocol-mcp-server`

Expose selected bread agents, tasks, tools, and agent+skill combinations as
[Model Context Protocol](https://modelcontextprotocol.io) tools, over stdio or Streamable HTTP, built
on the official v2 SDK (`@modelcontextprotocol/server` + the `@modelcontextprotocol/hono` adapter).
Both transports serve **both** the 2025-11-25 and 2026-07-28 protocol revisions from the same
endpoint/connection — nothing to configure, an MCP client on either revision just works.

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

## Transports, protocol eras, and auth

- **`transport: 'stdio'`** (default) — connects one persistent, **connection-pinned** MCP stdio
  server on `init()`, via the SDK's `serveStdio`: the opening exchange of that one connection selects
  2025-11-25 or 2026-07-28, and the whole connection speaks whichever era won. Use this when bread
  itself is launched as an MCP child process. There is no meaningful auth layer here by design: stdio
  is a local process pipe, and the OS process boundary *is* the trust boundary, the same as any other
  local CLI access.
- **`transport: 'http'`** — mounts a **stateless** Streamable HTTP endpoint on bread's own Hono app at
  `path` (default `/mcp`), via `createMcpHandler(..., { legacy: 'stateless' })`: a fresh MCP server
  per request either way, but the same handler answers 2026-07-28 natively and falls back to the
  2025-11-25 wire format bread has always served — one endpoint, both eras, still no session state on
  either side.

### DNS-rebinding protection

The HTTP route also validates the `Host` and `Origin` headers on every request (via
`@modelcontextprotocol/hono`'s `hostHeaderValidation`/`originValidation` middleware, wired through
the plugin's `middleware` hook) — a request from a hostname that isn't allow-listed is rejected with
`403` before it reaches auth or routing. **This defaults to localhost-only.** If bread is reachable
under a real hostname (anything other than `localhost`/`127.0.0.1`/`[::1]`), set `allowedHosts`
explicitly or every request will be rejected:

```ts
mcpServer({ transport: 'http', agents: ['researcher'], allowedHosts: ['mcp.example.com'] })
```

`allowedHosts` is port-agnostic (hostnames only) and applies to both the `Host` and `Origin` checks.
Real HTTP clients always send a `Host` header (mandatory since HTTP/1.1) — the one place this trips
people up is testing the route in-process against Hono's own `app.request()` helper, which doesn't
synthesize one; pass `headers: { host: 'localhost' }` explicitly in that case.

The HTTP route otherwise needs **no auth code of its own**. `createServer()` runs every plugin's
`middleware` hook before any plugin's `routes()` are mounted, so if you've wired an auth plugin (e.g.
`authPlugin(...)` from [auth.md](./auth.md)), `/mcp` is gated exactly like every other route — with
no special-casing on mcp-server's part. All middleware runs before any route, but the relative order
*between* mcp-server's host/origin check and another plugin's auth check follows `config.plugins`
registration order, same as any two plugins' middleware — it isn't otherwise enforced. Bread itself
applies no default auth posture; add it only if you want it. Connect with the SDK's
`StreamableHTTPClientTransport`.

## Building blocks

```ts
import { buildMcpServer, serveStdio, buildMcpHttpHandler } from '@breadai/protocol-mcp-server'
```

`mcpServer(expose)` is a thin plugin wrapper around these — reach for them directly only if you need
a custom mount point or transport bread's Hono integration doesn't cover. `buildMcpHttpHandler`
builds the dual-era handler once (call it once per process, not per request — its `.fetch(req)` is
what actually serves each request); `serveStdio` opens one connection-pinned dual-era stdio server.

See [`examples/mcp`](../examples/mcp) for a runnable version, paired with
[`@breadai/protocol-mcp-client`](./mcp-client.md) consuming it.
