<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/store-mysql

MySQL `BreadStore` — sessions, messages, checkpoints, loops, task runs, memories, and documents.
Search is keyword (`LIKE`) only. There is no vector index.

```bash
bun add @breadai/store-mysql   # or: npm i @breadai/store-mysql
```

```ts
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-mysql'

export default defineConfig({
  entrypoints: ['researcher'],
  store: store(), // reads MYSQL_URL; or store({ url })
})
```

`store()` reads `MYSQL_URL` or `url`. Nothing else supplies the host, user, or password.
A non-loopback host must use `mysqls://` (verified TLS). Cleartext, and a missing user, are
allowed only when `loopback: true` and the host is `localhost`, `127.0.0.1`, or `::1`.

```ts
store: store({ url: 'mysql://<host>:3306/<db>', loopback: true })
```

Tables are `bread_`-prefixed and created by `migrate()` (`bread start` runs it unless `--no-migrate`
or `server.migrate` is false). `0001_baseline` is the idempotent schema. Works on both Bun and Node.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [store](https://matteozambon89.github.io/bread/store.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
