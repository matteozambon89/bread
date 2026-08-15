# store-showcase

One `echo` agent, three storage backends — proof that any `BreadStore` drops into
the same config. `STORE` is **required**; core has no auto-wired or interactive
store fallback, so an unset or unknown value fails fast with a message naming the
valid ones.

| `STORE` | Package | Notes |
|---------|---------|-------|
| `memory` | `@breadai/store-memory` | Ephemeral, no setup. Great for a quick try or tests. |
| `sqlite-bun` | `@breadai/store-sqlite` | Persists to `./bread.db` via Bun's built-in `bun:sqlite`. |
| `postgres` | `@breadai/store-postgres` | The recommended backend. Needs `DATABASE_URL`. |

```bash
STORE=memory      bread dev     # zero setup
STORE=sqlite-bun  bread dev     # file-backed, Bun
DATABASE_URL=postgres://… STORE=postgres bread dev
```

`bread dev` with no `STORE` set is a hard error, not a silent default — that's the point of the
example. (`bun run build` pins `STORE=memory` in its script: `bread build` only validates each
agent's schemas and model config, so which store is wired is irrelevant to it.)

Then hit the agent:

```bash
curl -N localhost:3000/agents/echo/run -d '{"input":"hello"}'
```

Swapping backends never touches the agent — only the `store` line in
[`bread.config.ts`](./bread.config.ts) changes.
