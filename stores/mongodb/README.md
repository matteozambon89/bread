<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/store-mongodb

MongoDB `BreadStore` — sessions, messages, checkpoints, loops, task runs, memories, and documents.
Search is keyword only. There is no vector step.

```bash
bun add @breadai/store-mongodb   # or: npm i @breadai/store-mongodb
```

```ts
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-mongodb'

export default defineConfig({
  entrypoints: ['researcher'],
  store: store(), // reads MONGODB_URL; or store({ url })
})
```

The URL comes from `url` or `MONGODB_URL`. It needs verified TLS and credentials.
`mongodb+srv://<host>/<db>` keeps the driver's TLS default. A `mongodb://` URL needs `tls=true`.
Cleartext or no auth is allowed only when `loopback: true` is set and every host is loopback
(`localhost`, `127.0.0.1`, or `::1`).

```ts
store: store({ url: 'mongodb://127.0.0.1:27017/bread', loopback: true })
```

`migrate()` applies `0001_baseline`. `bread start` calls it unless `--no-migrate` or
`server.migrate` is false. A direct caller queries after `migrate()`. Collections are not created
before that. A provided search limit must be an integer from 1 to 1000. User text in a keyword
query is escaped.

A crashed migrate can leave the `bread_migration_lock` document. Remove that document before
retrying. The baseline is safe to run again, and a stored checksum is not rewritten.

Works on Bun and Node.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [store](https://matteozambon89.github.io/bread/store.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
