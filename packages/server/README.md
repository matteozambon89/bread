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
// `app` is a Hono app — mount it yourself, or bind with a runtime adapter:
//   Bun:  startServer from @breadai/runtime-bun
//   Node: startServerNode from @breadai/runtime-node
```

This package owns `createServer` (and `app.fetch`) only — listen adapters live in
`@breadai/runtime-bun` / `@breadai/runtime-node`. Bread applies no default auth
posture — add one yourself via `authPlugin(...)` in `config.plugins` (see
[auth](https://matteozambon89.github.io/bread/auth.html)) if you want
it. Errors reach clients as `{ code, message }` only.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [HTTP API](https://matteozambon89.github.io/bread/http-api.html) ·
[auth](https://matteozambon89.github.io/bread/auth.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
