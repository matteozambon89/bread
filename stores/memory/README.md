<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @bread/store-memory

In-memory `BreadStore` — ephemeral, zero-setup, gone when the process exits. The full store
contract (sessions, messages, checkpoints, loops, task runs, knowledge graph, documents) for
tests, examples, and quick local tries. Works on both Bun and Node.

```bash
bun add @bread/store-memory   # or: npm i @bread/store-memory
```

```ts
import { defineConfig } from '@bread/core'
import { store } from '@bread/store-memory'

export default defineConfig({
  entrypoints: ['echo'],
  store: store(),
})
```

For anything that should survive a restart, use
[`@bread/store-postgres`](https://www.npmjs.com/package/@bread/store-postgres) or one of the
SQLite stores.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [store](https://github.com/matteozambon89/bread/blob/HEAD/docs/store.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
