<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/runtime-bun

Bun listen adapter for [`@breadai/server`](https://github.com/matteozambon89/bread/tree/HEAD/packages/server):
builds the same Hono app via `createServer`, then serves `app.fetch` with
[`Bun.serve`](https://bun.com/docs/api/http).

Use this when you are already on Bun. For a Node process, use
[`startServerNode`](https://github.com/matteozambon89/bread/tree/HEAD/packages/runtime-node)
from `@breadai/runtime-node` — do not call `@hono/node-server`'s `serve()` in the same process as
`Bun.serve` (it permanently breaks Bun Response handling).

```bash
bun add @breadai/runtime-bun
```

```ts
import { loadAgents, loadConfig, loadTasks } from '@breadai/server'
import { startServer } from '@breadai/runtime-bun'

const config = await loadConfig(process.cwd())
const agents = await loadAgents(process.cwd(), config.entrypoints)
const { bread, stop } = await startServer(
  config,
  agents,
  // port/host from opts → config.server → 3000/localhost
  {},
  await loadTasks(process.cwd()),
)

// later: await stop()
```

`@breadai/server` still owns `createServer` (and `app.fetch`); this package is
listen-only.

Part of **[bread](https://github.com/matteozambon89/bread)**.

## License

MIT © Matteo Zambon
