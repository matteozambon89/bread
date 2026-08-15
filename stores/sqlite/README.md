<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/store-sqlite

SQLite `BreadStore` on Bun's built-in [`bun:sqlite`](https://bun.sh/docs/api/sqlite) — a local
file, no service, no native addon. The full store contract: sessions, messages, checkpoints,
loops, task runs, knowledge graph, documents.

```bash
bun add @breadai/store-sqlite
```

```ts
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-sqlite'

export default defineConfig({
  entrypoints: ['researcher'],
  store: store({ path: './bread.db' }),   // or ':memory:'
})
```

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [store](https://github.com/matteozambon89/bread/blob/HEAD/docs/store.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
