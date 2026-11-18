<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/store-mssql

SQL Server `BreadStore` — sessions, messages, checkpoints, loops, task runs, memories, and documents.
Search is keyword only. There is no `embed` option.

```bash
bun add @breadai/store-mssql   # or: npm i @breadai/store-mssql
```

```ts
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-mssql'

export default defineConfig({
  entrypoints: ['researcher'],
  store: store(), // reads MSSQL_URL; or store({ url })
})
```

The connection string is `mssql://<host>:1433/<db>` or an ADO `Server=` string. `store()` reads
`MSSQL_URL` or `url`. Nothing else supplies the host, user, or password. `encrypt` stays on.
`trustServerCertificate` stays off unless `loopback: true` and the host is loopback
(`localhost`, `127.0.0.1`, or `::1`).

Tables are `bread_`-prefixed and created by `migrate()` (`bread start` runs it unless
`--no-migrate` or `server.migrate` is false). `0001_baseline` is the idempotent schema.
Works on both Bun and Node.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [store](https://matteozambon89.github.io/bread/store.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
