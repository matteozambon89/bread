<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @bread/store-postgres

Postgres `BreadStore` — bread's production-default persistence: sessions, messages, checkpoints,
loops, task runs, knowledge graph, and documents, with optional
[pgvector](https://github.com/pgvector/pgvector) semantic search when you pass an `embed`
function.

```bash
bun add @bread/store-postgres   # or: npm i @bread/store-postgres
```

```ts
import { defineConfig } from '@bread/core'
import { store } from '@bread/store-postgres'

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
