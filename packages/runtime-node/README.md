<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/runtime-node

Node.js listen adapter for [`@breadai/server`](https://github.com/matteozambon89/bread/tree/HEAD/packages/server):
builds the same Hono app via `createServer`, then serves `app.fetch` with
[`@hono/node-server`](https://github.com/honojs/node-server).

Use this when you need a **Node** process (e.g. Amazon Bedrock AgentCore's
managed Node runtime). Prefer Bun's `startServer` from `@breadai/runtime-bun` when
you are already on Bun — that path stays `Bun.serve` and is unchanged by this
package.

```bash
npm i @breadai/runtime-node   # or: bun add @breadai/runtime-node
```

```ts
import { loadAgents, loadConfig, loadTasks } from '@breadai/server'
import { startServerNode } from '@breadai/runtime-node'

const config = await loadConfig(process.cwd())
const agents = await loadAgents(process.cwd(), config.entrypoints)
const { bread, stop } = await startServerNode(
  config,
  agents,
  // Same opts API as Bun startServer (port/host from opts → config.server → 3000/localhost).
  // AgentCore (and similar container hosts) should pass host 0.0.0.0 and port 8080:
  // { host: '0.0.0.0', port: 8080 },
  {},
  await loadTasks(process.cwd()),
)

// later: await stop()
```

AgentCore-specific routes / protocol wiring land in a later PR — this package is
listen-only.

Part of **[bread](https://github.com/matteozambon89/bread)**.

## License

MIT © Matteo Zambon
