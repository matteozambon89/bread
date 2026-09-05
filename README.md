<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# bread

**Explicit by design.** A file-system-convention framework for building, running, and observing AI
agents on top of the [Vercel AI SDK](https://sdk.vercel.ai) — no silent defaults: you pick the
store, the transport, and the providers yourself, and bread refuses to guess on your behalf.

You define agents as folders. bread loads them, runs them, streams their work as structured
events ("crumbs"), and serves them over HTTP — with sessions, tools, human-in-the-loop,
skills, pipelines, supervisors, evals, and a plugin system built in.

```ts
// agents/echo/agent.ts
import { defineAgent } from '@breadai/core'
import { z } from 'zod'

export default defineAgent({
  model: { provider: 'anthropic', model: 'claude-opus-4-8' },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
})
```

```ts
// bread.config.ts — the store/transport/providers above are never inferred
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'
import { providerCatalog } from '@breadai/provider-catalog'

export default defineConfig({
  entrypoints: ['echo'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
})
```

```bash
bread dev      # → http://localhost:3000
curl -N -X POST localhost:3000/agents/echo/run -d '{"input":"hello"}'
```

---

## Install

```bash
bun add @breadai/core      # SDK
bun add -d @breadai/cli    # dev server + `bread` CLI
```

Core has no built-in model providers — register them explicitly via `providers` in
`bread.config.ts`. `@breadai/provider-catalog` packages 20 lazily-imported providers (each
still an optional peer dep, installed only if you use it):

```bash
bun add @breadai/provider-catalog
bun add @ai-sdk/anthropic       # provider: 'anthropic'
```

```ts
import { providerCatalog } from '@breadai/provider-catalog'

export default defineConfig({
  entrypoints: ['echo'],
  providers: providerCatalog,
})
```

### Runtime

`bread` runs on **Bun** — the `@breadai/store-sqlite` store (`bun:sqlite`) works out of the box.

## Project layout

bread discovers everything by convention from your project root:

```
bread.config.ts            # entrypoints, pipelines, plugins, store
agents/
  researcher/
    agent.ts               # defineAgent({...})
    prompt.md              # system prompt
    tools/web-search.ts    # defineTool({...}) — auto-loaded
    skills/deep-research/
      SKILL.md             # frontmatter + instructions
      scripts/*.ts         # skill tools
    evals/quality.eval.ts  # defineEval({...})
```

```ts
// bread.config.ts
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['researcher', 'writer'],
  // Both are required, explicitly — no auto-wired fallback. Swap for the
  // Postgres store() (reads DATABASE_URL) and @breadai/transport-http-sse
  // (SSE/browser-EventSource) as needed.
  store: store({ path: './bread.db' }),
  transport: transport(),
})
```

## CLI

| Command | What it does |
|---------|--------------|
| `bread dev` | Dev server with hot reload (`-p` port, `-H` host) |
| `bread build` | Validate every agent has an `inputSchema`, `outputSchema`, and complete `model` config (see [`docs/cli.md`](./docs/cli.md#build) — no type-checking) |
| `bread start` | Production server (no watch) |
| `bread chat [agent]` | Interactive REPL with an agent; resume with `-s <id>` (supports HITL) |
| `bread invoke <agent> [input]` | Run an agent once; `--json` for structured output (no HITL) |
| `bread eval [path]` | Run evals in `agents/**/evals/*.eval.ts` |
| `bread sessions list` | List sessions (`--tag key=value`) |
| `bread sessions cleanup` | Bulk delete (`--older-than <days>`, `--tag`) |
| `bread provider list` | List catalog providers with install/env status for this project |
| `bread provider add <name>` | Install a catalog provider's peer package and show required env vars |

## HTTP API

| Method & path | Description |
|---------------|-------------|
| `GET /agents` | List agents |
| `GET /agents/:id` | Agent schema |
| `POST /agents/:id/run` | Run an agent — streams crumbs (wire format below). Body: `{ input, session?, skill? }` |
| `POST /pipelines/:id/run` | Run a pipeline — streams crumbs |
| `POST /resume/:checkpointId` | Resume a HITL checkpoint. Body: `{ response }` |
| `GET /sessions` · `GET /sessions/:id` · `DELETE /sessions/:id` | Session CRUD |
| `POST /sessions/cleanup` | Bulk delete sessions |
| `GET /runs/:runId/stream` | Passively tail any run — crumb-log catch-up via `Last-Event-ID`, then live transport frames; works from any replica |
| `GET /loops` · `GET /loops/:id` | List loops (`?session` `?agent` `?status`) · loop with iterations |
| `GET /tasks` · `GET /tasks/:id` | List task runs (`?task` `?session` `?agent` `?status` `?limit`) · a task run |

The four streaming routes are mounted by whichever `config.transport` you pick — pick
`@breadai/transport-http-sse` for SSE (`id: <seq>` + `data: { "type": <crumb type>, "payload": <crumb>
}`) or `@breadai/transport-http-chunked` for NDJSON (one Bread protocol `CrumbFrame` JSON line per
chunk) — see [`docs/http-api.md`](./docs/http-api.md). Scale horizontally by sharing one store and
one cross-replica transport (e.g. `@breadai/transport-redis`) across replicas — see
[`docs/transports.md`](./docs/transports.md).

## Plugins

```ts
import { defineConfig } from '@breadai/core'
import { otel } from '@breadai/otel'
import { agUi } from '@breadai/protocol-ag-ui'

export default defineConfig({
  entrypoints: ['researcher'],
  plugins: [otel(), agUi()],
})
```

Available: `@breadai/otel`, `@breadai/protocol-ag-ui`, `@breadai/protocol-a2a-server`, `@breadai/a2ui`,
`@breadai/protocol-mcp-client`, `@breadai/protocol-mcp-server`. Write your own by implementing
`BreadPlugin` — see [`docs/plugins.md`](./docs/plugins.md). `@breadai/auth-api-key`/`-jwt`/`-oauth2`
are standalone auth strategy/signer factories, not plugins themselves — wrap one with
`@breadai/server`'s `authPlugin()` to attach it (see [`docs/auth.md`](./docs/auth.md)). Transports
are config-level, not plugins: `@breadai/transport-http-chunked`/`@breadai/transport-http-sse` (HTTP
ingress + remote agents), `@breadai/transport-redis` (cross-replica fan-out), `@breadai/transport-stdout`
(CLI rendering) — see [`docs/transports.md`](./docs/transports.md).

## Documentation

Start with [`docs/architecture.md`](./docs/architecture.md), then:
[CLI](./docs/cli.md) ·
[agents](./docs/agents.md) ·
[providers](./docs/providers.md) ·
[tools](./docs/tools.md) ·
[skills](./docs/skills.md) ·
[sessions](./docs/sessions.md) ·
[HITL](./docs/hitl.md) ·
[pipelines](./docs/pipelines.md) ·
[loops](./docs/loops.md) ·
[tasks](./docs/tasks.md) ·
[evals](./docs/evals.md) ·
[plugins](./docs/plugins.md) ·
[remote agents](./docs/remote-agents.md) ·
[transports](./docs/transports.md) ·
[MCP client](./docs/mcp-client.md) ·
[MCP server](./docs/mcp-server.md) ·
[A2A server](./docs/a2a.md) ·
[auth](./docs/auth.md) ·
[otel](./docs/otel.md) ·
[AG-UI](./docs/ag-ui.md) ·
[HTTP API](./docs/http-api.md) ·
[store](./docs/store.md) ·
[glossary](./docs/glossary.md).

Runnable [`examples/`](./examples) cover hello-world through supervisors, HITL, pipelines, loops, and plugins.

## Changelog

Release notes are published per version on [GitHub Releases](https://github.com/matteozambon89/bread/releases).

## License

MIT © Matteo Zambon
