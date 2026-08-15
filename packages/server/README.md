<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/server

The reference HTTP ingress for bread: a [Hono](https://hono.dev) app serving agents, pipelines,
sessions, loops, task runs, and HITL resume as SSE/JSON routes, plus the file-system loader
(`agents/<id>/agent.ts`, `prompt.md`, `tools/`, `skills/`, `tasks/`) the CLI is built on.
Importable as a library — you don't need the CLI to embed it.

```bash
bun add @breadai/server   # or: npm i @breadai/server
```

```ts
import { createServer, loadAgents, loadConfig, loadTasks } from '@breadai/server'

const config = await loadConfig(process.cwd())
const agents = await loadAgents(process.cwd(), config.entrypoints)
const { bread, app } = createServer(config, agents, await loadTasks(process.cwd()))
await bread.start()
// `app` is a Hono app — mount it yourself, or bind with startServer(config, agents).
```

`startServer` binds via `Bun.serve`. Bread applies no default auth posture — add one yourself via
`authPlugin(...)` in `config.plugins` (see [auth](https://github.com/matteozambon89/bread/blob/HEAD/docs/auth.md))
if you want it. Errors reach clients as `{ code, message }` only.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [HTTP API](https://github.com/matteozambon89/bread/blob/HEAD/docs/http-api.md) ·
[auth](https://github.com/matteozambon89/bread/blob/HEAD/docs/auth.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
