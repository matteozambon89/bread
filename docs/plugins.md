# Plugins

A plugin extends or integrates with bread. Add plugins to `config.plugins`; bread runs their
lifecycle and merges their contributions on `start()`. First-party plugins with their own doc
pages: [otel](./otel.md) · [ag-ui](./ag-ui.md) · [MCP client](./mcp-client.md) ·
[MCP server](./mcp-server.md) · [auth](./auth.md).

> Model providers are a config-level seam, not a plugin one — see
> [agents.md#providers](./agents.md#providers).

```ts
// bread.config.ts
import { otel } from '@bread/otel'
import { agUi } from '@bread/protocol-ag-ui'

export default defineConfig({
  entrypoints: ['researcher'],
  plugins: [otel(), agUi()],
})
```

## The `BreadPlugin` interface

```ts
interface BreadPlugin {
  name: string
  init?(bread: BreadInstanceRef): Promise<void>
  close?(): Promise<void>
  hooks?: Partial<BreadHooks>                                     // global beforeRun/afterRun/onError/onSuspend
  agents?: Record<string, AgentDefinition>                        // pre-built agents
  tools?: ToolDefinition[]                                        // global tools
  resolveAgentTools?(agentId: string, cfg: AgentConfig): Promise<ToolDefinition[]> | ToolDefinition[]
  middleware?: (app: unknown) => void                            // register server middleware
  routes?: (app: unknown) => void                                // register HTTP routes
}
```

> Storage is configured directly via `store` in `BreadConfig` — see [store.md](./store.md) — not
> through plugins.

### What each field does

- **`init` / `close`** — lifecycle. `init` receives a `BreadInstanceRef` so the plugin can
  `bread.on('crumb', …)`. `close` runs on `stop()`.
- **`hooks`** — the same `BreadHooks` every `BreadConfig.hooks` implements (see
  [agents.md#hooks](./agents.md#hooks)), merged into the global tier of *every* scope's hook chain
  (agent, task, and tool runs alike) — plugins run after the scoped hook but before
  `BreadConfig.hooks`, in `config.plugins` registration order. This is the supported way for a
  plugin to observe or react to every run without the caller wiring anything — an observability
  plugin watching for failures, for instance, uses this instead of `bread.on('crumb', …)`.
- **`agents`** — pre-built agents the plugin contributes to the registry.
- **`tools`** — global, static tools. Collected on `start()` and merged into every agent's tool set
  (alongside the agent's own tools and skills), so a plugin can expose a capability to all agents at
  once. See [tools.md](./tools.md).
- **`resolveAgentTools`** — the *dynamic* counterpart to `tools`: called once per agent during tool
  assembly, given that agent's full config, so a plugin can contribute tools driven by something the
  agent itself declared (rather than every agent getting the same static set). Core never inspects
  what an agent puts under `cfg.plugins.<your-plugin-name>` — that key is entirely yours to define and
  read back inside this hook. Returned tools get the same `plugin:<your-plugin-name>/<tool>`
  provenance and permission treatment as static `tools`, including the collision check if a name
  clashes. [`@bread/protocol-mcp-client`](./mcp-client.md) is the reference implementation — it reads
  `cfg.plugins.mcp_client` to resolve MCP servers a specific agent asked to connect to.
- **`middleware`** — register middleware on the server's Hono app, applied before any routes (this
  plugin's own or another plugin's) so it can wrap everything downstream regardless of plugin
  registration order. Typed as `unknown` for the same reason as `routes` below. Auth is the
  motivating case — `@bread/server`'s `authPlugin()` builds a `BreadPlugin` whose `middleware` gates
  every request — but the mechanism is fully generic; any plugin can use it (rate limiting, CORS,
  request logging, …). See [auth.md](./auth.md).
- **`routes`** — register extra HTTP routes on the server's Hono app (e.g.
  [`@bread/protocol-mcp-server`](./mcp-server.md)'s HTTP exposure). Typed as `unknown` so core stays Hono-free;
  the CLI server passes the real `Hono`.

## Writing a plugin

```ts
import type { BreadPlugin } from '@bread/core'

export function metrics(): BreadPlugin {
  let count = 0
  return {
    name: 'metrics',
    async init(bread) {
      bread.on('crumb', (c) => {
        if (c.type === 'agent:run:end') count++
      })
    },
    async close() {
      console.log(`[metrics] ${count} runs`)
    },
  }
}
```

## Protocols vs. extensions

First-party plugins are split across two workspace folders — a naming/discovery convention, not a
second plugin mechanism; both implement the same `BreadPlugin` interface above:

- **`protocols/`** (`@bread/protocol-ag-ui`, `@bread/protocol-a2a-server`,
  `@bread/protocol-mcp-client`, `@bread/protocol-mcp-server`) — adapters for a specific wire
  protocol (AG-UI, A2A, MCP).
- **`extensions/`** (`@bread/otel`, `@bread/a2ui`) — everything else that attaches as a
  `BreadPlugin`: observability, UI generation. (`@bread/auth-api-key`/`-jwt`/`-oauth2` also live
  under `extensions/` but are standalone `BreadAuthStrategy`/`BreadSigner` factories, not
  `BreadPlugin`s themselves — wrap one with `authPlugin()` from `@bread/server` to attach it, see
  [auth.md](./auth.md).)

See [architecture.md](./architecture.md#package-families) for the full five-family package map.

## Publishing

The whole project lives under the **`@bread/`** scope — the core runtime and tooling
(`@bread/core`, `@bread/server`, `@bread/cli`) alongside plugins (e.g. `@bread/foo`). Export a
factory function that returns a `BreadPlugin`.
