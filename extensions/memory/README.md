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

The backend in this package is `{ kind: 'store', store }`. SQLite and the memory store search by
keyword. Postgres uses the document embed path when `embed` is set. Dream calls the model you pass,
not the agent model.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [memory](https://matteozambon89.github.io/bread/memory.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
