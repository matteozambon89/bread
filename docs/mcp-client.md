# MCP client — `@breadai/protocol-mcp-client`

Consume external [Model Context Protocol](https://modelcontextprotocol.io) servers, built on the
official `@modelcontextprotocol/sdk`. Their tools become ordinary bread tools for any agent that
opts in — either a server declared once at the top level, or one declared inline on a single agent.

```bash
bun add @breadai/protocol-mcp-client
```

`@breadai/protocol-mcp-client` is a regular [plugin](./plugins.md); core has no built-in notion of MCP at all —
it only knows about the generic `BreadPlugin.resolveAgentTools` hook this plugin implements. See
[tools.md](./tools.md#where-an-agents-tools-come-from) for how that fits into the rest of an agent's
tool set, and [plugins.md](./plugins.md) for the hook itself.

## Config-level servers

```ts
// bread.config.ts
import { defineConfig } from '@breadai/core'
import { mcpClient } from '@breadai/protocol-mcp-client'
import { signer } from '@breadai/auth-oauth2'

export default defineConfig({
  entrypoints: ['researcher'],
  plugins: [
    mcpClient({
      servers: [
        { name: 'filesystem', transport: 'stdio', command: 'mcp-server-filesystem', args: ['/data'] },
        { name: 'search', transport: 'http', url: 'https://mcp.example.com/mcp',
          signer: signer({ tokenUrl: '…', clientId: '…', clientSecret: '…' }) },
      ],
    }),
  ],
})
```

On startup the plugin connects each server, lists its tools, and translates their JSON Schemas to
zod. An agent gets a server's tools by naming it under `cfg.plugins.mcp_client.servers`:

```ts
defineAgent({
  // …
  plugins: {
    mcp_client: { servers: ['filesystem', 'search'] },  // only these servers' tools are injected
  },
})
```

## Inline per-agent servers

For a server that belongs to one agent rather than the whole config, skip the top-level `servers`
list and declare it directly under that agent's own `plugins.mcp_client.external`:

```ts
defineAgent({
  // …
  plugins: {
    mcp_client: {
      external: [{ name: 'search', url: 'https://mcp.example.com/mcp', headers: { 'x-api-key': '…' } }],
    },
  },
})
```

Each `external` entry is connected lazily, on first use, and cached by `name` + `url` — two agents
(or two runs of the same agent) referencing the identical `{name, url}` reuse one connection, closed
once when the plugin's `close()` runs. `external` is deliberately **http-only**: no `command` to
spawn a local process. `servers` (top-level) can spawn stdio processes because it already requires
editing `bread.config.ts` — a per-agent field is a smaller trust surface, so it doesn't get that.

`servers` and `external` can be combined on the same agent; every tool from either source is
name-mangled `<server>__<tool>` and tagged `plugin:mcp_client/<server>__<tool>`, so two servers can't
collide even if they happen to expose a same-named tool, and both sources get identical
`permissions.{allow,ask,deny}` and `TOOL_NAME_COLLISION` treatment — see [agents.md](./agents.md).

Server-side tool names are **sanitized** into bread's snake_case convention before mangling —
`list-files` → `list_files`, `readFile` → `read_file` — while the original name is kept for the
actual MCP call (and noted in the tool's description). Two server tools that sanitize to the same
name fail the connection with `TOOL_NAME_COLLISION`, naming both originals.

**No reconnection.** A connection lost after `init()` (server restart, network drop) is not
re-established — affected tools fail until the bread process restarts (config-level `servers`) or
a new run re-resolves the cached `external` entry. Front a flaky server with something that keeps
the endpoint stable.

## Transports

- **`stdio`** — spawns `command`/`args`/`env` as a local child process (`servers` only, not
  `external`).
- **`http`** — the current [Streamable HTTP](https://modelcontextprotocol.io) transport.
- **Legacy SSE fallback** — automatic. If a server responds to Streamable HTTP with a 4xx (i.e. it
  predates Streamable HTTP and only speaks the deprecated HTTP+SSE transport), the client
  transparently retries the same URL over `SSEClientTransport`. No config needed.

## Credentials

A server's `signer` field is a [`BreadSigner`](./auth.md) — its `sign(headers)` runs on
**every outgoing request**, so signers with expiring credentials refresh naturally: an
`@breadai/auth-oauth2` `signer(...)` re-uses its cached token until the expiry window, then fetches
a fresh one mid-connection with no reconnect. Compose it with bread's credential primitives to
keep secrets out of `bread.config.ts` directly:

```ts
import { vaultProvider } from '@breadai/core'

const vault = vaultProvider({ address: '…', token: process.env.VAULT_TOKEN! })

mcpClient({
  servers: [{
    name: 'search',
    url: 'https://mcp.example.com/mcp',
    signer: { name: 'search_key', async sign(h) { h.set('x-api-key', await vault.get('search-key')) } },
  }],
})
```

`external`'s `headers` (per agent) are static — resolve them the same way, at config-build time,
before they reach `defineAgent`.

**Non-goal:** there is no interactive OAuth 2.1 authorization-code flow. That flow is
browser-redirect-shaped (a human approves a consent screen), which doesn't fit a backend agent
connecting to a pre-configured server non-interactively. Bearer/API-key auth via `BreadSigner`
— including a token you obtained through OAuth some other way — is the supported mechanism.

## Building blocks

The package also exports its primitives for custom wiring:

```ts
import { connectServer, jsonSchemaToZod } from '@breadai/protocol-mcp-client'

const calc = await connectServer({ name: 'calc', command: 'bun', args: ['server.ts'] })
calc.tools           // ToolDefinition[] ready to hand to an agent
await calc.close()
```
