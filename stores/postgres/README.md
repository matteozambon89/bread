<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/store-postgres

Postgres `BreadStore` — bread's production-default persistence: sessions, messages, checkpoints,
loops, task runs, knowledge graph, and documents, with optional
[pgvector](https://github.com/pgvector/pgvector) semantic search when you pass an `embed`
function.

```bash
bun add @breadai/store-postgres   # or: npm i @breadai/store-postgres
```

```ts
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-postgres'

export default defineConfig({
  entrypoints: ['researcher'],
  store: store(),                  // reads DATABASE_URL; or store({ url })
})
```

Tables are `bread_`-prefixed and created by `migrate()` (the server runs it at boot). Works on
both Bun and Node.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [store](https://github.com/matteozambon89/bread/blob/HEAD/docs/store.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
