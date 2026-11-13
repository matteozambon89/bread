<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/memory

Memory plugin for bread. Agents opt in with `plugins: { memory: {} }` and get `memorize`,
`recall`, `forget`, and `dream`. Rows are scoped to the agent and the run principal
(`iss` + `sub`). `forget` and `dream` ask; an exact `permissions.allow` entry can skip ask, and a
glob allow cannot.

```bash
bun add @breadai/memory   # or: npm i @breadai/memory
```

```ts
import { defineConfig } from '@breadai/core'
import { memory } from '@breadai/memory'
import { store } from '@breadai/store-sqlite'

const backend = store({ path: './bread.db' })

export default defineConfig({
  entrypoints: ['memory'],
  store: backend,
  plugins: [
    memory({
      backend: { kind: 'store', store: backend },
      model: () => myLanguageModel,
    }),
  ],
})
```

`memory({ backend, model })` takes one backend. `{ kind: 'store', store }` writes the `BreadStore`.
`{ kind: 'graph', graph, store }` writes `:BreadMemory` through `Graph.run`. That `store` is only
there so dream can read the transcript. `{ kind: 'combined', store, graph }` writes the store first
and a graph node with the same id. Recall reads the store, so a Postgres `embed` still applies
there. If the graph write throws, the store row stays. A returned row dropped for size is not an
owner mismatch, and dream does not write that id again. `forget` deletes the owned graph node first
and does not report `{ deleted: true }` when that delete throws.

```ts
memory({ backend: { kind: 'graph', graph, store: backend }, model: () => myLanguageModel })
memory({ backend: { kind: 'combined', store: backend, graph }, model: () => myLanguageModel })
```

`graph` is the same value as `config.graph`. This package does not take a driver URL. The Cypher is
owned by the package. SQLite and the memory store search by keyword. Dream calls the model you
pass, not the agent model.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [memory](https://matteozambon89.github.io/bread/memory.html) ·
[graph](https://matteozambon89.github.io/bread/graph.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
