<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/core

Core SDK for bread — a file-system-convention framework for building AI agents ("Next.js for
agents"). Everything runtime lives here: the agent runner, tools, tasks, skills, loops,
supervisors, pipelines, sessions, HITL checkpoints, permissions, hooks, and the `BreadStore` /
`BreadPlugin` contracts. No HTTP, no CLI — bring your own ingress or use
[`@breadai/server`](https://www.npmjs.com/package/@breadai/server).

```bash
bun add @breadai/core   # or: npm i @breadai/core
```

```ts
import { createBread, defineAgent } from '@breadai/core'
import { store } from '@breadai/store-memory'
import { z } from 'zod'

const echo = defineAgent({
  model: { provider: 'anthropic', model: 'claude-opus-4-8' },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
})

const bread = createBread(
  { entrypoints: ['echo'], store: store() },
  new Map([['echo', echo]]),
)
await bread.start()

for await (const crumb of bread.run('echo', 'hello', { mode: 'stream' })) {
  if (crumb.type === 'text:delta') process.stdout.write(crumb.delta)
}
```

Key exports: `defineAgent` · `defineTool` · `defineHumanTool` · `defineTask` · `defineConfig` ·
`createBread` · `runPipeline` · `runEvals` · `envProvider`/`vaultProvider` (credentials) ·
`BreadError` · the `BreadStore`/`BreadPlugin`/`BreadCrumb` types.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [architecture](https://github.com/matteozambon89/bread/blob/HEAD/docs/architecture.md) ·
[agents](https://github.com/matteozambon89/bread/blob/HEAD/docs/agents.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
