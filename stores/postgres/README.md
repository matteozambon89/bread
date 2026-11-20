<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/store-postgres

Postgres `BreadStore` — bread's production-default persistence: sessions, messages, checkpoints,
loops, task runs, memories, and documents, with optional
[pgvector](https://github.com/pgvector/pgvector) semantic search when you pass `embed`.

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

`embed` is either `(text: string) => Promise<number[]>` or `{ provider, model }`.
A function is called as-is and does not read `config.embeddings`. A ref is resolved
on document ingest, document search, memory write, and memory search,
not when the config module is imported.
Pass the store through `defineConfig` so that ref can see `config.embeddings`.

```ts
store: store({ embed: { provider: 'openai', model: 'text-embedding-3-small' } })
```

```ts
store: store({ embed: async (text) => [text.length, 1] })
```

Tables are `bread_`-prefixed and created by `migrate()` (`bread start` runs it unless `--no-migrate`
or `server.migrate` is false). Works on both Bun and Node. `0001_baseline` is the idempotent schema.
When `embed` is set, `migrate()` also applies `0002_vector` (`CREATE EXTENSION vector`). An
already-applied `0002_vector` stays valid when `embed` is unset.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [store](https://matteozambon89.github.io/bread/store.html#semantic-vector-search) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
