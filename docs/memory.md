# Memory — `@breadai/memory`

`memory()` is a `BreadPlugin`. It stores durable facts on the `BreadStore` you pass in.
Nothing is copied into a later run's prompt. An agent opts in with `plugins: { memory: {} }`.
`null` and `false` leave the tools off. Core does not attach them.

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

```ts
defineAgent({
  plugins: { memory: {} },
})
```

The plugin reads `cfg.plugins.memory` only to decide whether the agent opted in. That value does
not choose the store or the owner. The store is the one closed over in `memory()`.

## Tools

| Tool | Model-facing name | Selector | Asks |
|------|-------------------|----------|------|
| `memorize` | `plugin_memory_memorize` | `plugin:memory/memorize` | no |
| `recall` | `plugin_memory_recall` | `plugin:memory/recall` | no |
| `forget` | `plugin_memory_forget` | `plugin:memory/forget` | yes |
| `dream` | `plugin_memory_dream` | `plugin:memory/dream` | yes |

`memorize` takes `{ content }`. `recall` takes `{ query, limit? }` (`limit` is 1–50) and calls
`searchMemories`. `forget` takes `{ id }`. `dream` takes no arguments. Schemas have no `agentId`,
principal, `iss`, `sub`, or `sessionId`.

`forget` and `dream` set `ask: true`. `gateAskDefaults` is the only gate. An exact
`permissions.allow` entry (no `*`) can skip ask when `permissions.ask` does not also match. A glob
allow cannot. See [agents.md](./agents.md#permissions).

`memorize` and `recall` are not ask-gated. A model can store transcript text, and recall returns
`content` on the run stream.

## Scope

Every read and write uses `ctx.agentId` plus `ctx.principal.iss` and `ctx.principal.sub`, taken
from the run. Tool arguments cannot set them. Equality is exact: `iss` and `sub` are not
case-folded, and tenant is not an ownership key. Two tenants with the same `iss` and `sub` share
memories, the same way they share sessions.

A missing principal throws `MEMORY_PRINCIPAL_REQUIRED` with `{ agentId, runId }`. The store never
inserts an unscoped row. `forget` deletes only when the id and that owner match, and returns
`{ deleted: false }` otherwise.

Loopback without auth and MCP stdio still share one stamped principal, so they share one memory
bucket. There is no session column. Deleting a session does not delete memories.

## Search

`searchMemories` defaults `limit` to 10. `listMemories` defaults it to 100 and never embeds.
Both return newest first on the keyword path. Search matches `content` only.

SQLite (`content LIKE`) and `@breadai/store-memory` (`includes`, case-insensitive) are keyword-only.
They take no `embed` option. Postgres uses the same embed path as documents when `embed` is set:
memory write embeds `content`, memory search embeds the query and ranks with `<=>`. That vector
predicate still requires `agent_id`, `principal_iss`, `principal_sub`, and `embedding IS NOT NULL`.
Without `embed`, Postgres search is `content ILIKE`. A ref is resolved on those operations, not at
import. See [store.md](./store.md#semantic-vector-search).

## Dream

`model` is a `LanguageModel`, or `() => LanguageModel | Promise<LanguageModel>`, so
`bread.config.ts` can stay sync. Dream calls that factory. It does not use the agent model.

After ask, dream reads up to 100 memories and the last 50 session messages (`getMessages` is
oldest first). `generateObject` uses `maxRetries: 0` and the run's `AbortSignal`. It writes every
new row first, then forgets ids that were in the loaded page. An id outside that page, including
another caller's id, is ignored. A failed forget leaves the new row and the old row. The result is
`{ written, forgotten }`.

A model or factory failure throws `MEMORY_DREAM_FAILED`. The message is fixed. Context is
`{ agentId, runId }` only. The prompt and memory text are not put on the error.

A store that is missing `addMemory`, `searchMemories`, `listMemories`, or `forgetMemory` throws
`STORE_NO_MEMORY` with `{ missing }` when `memory()` is called.

## Leftover knowledge-graph tables

`migrate()` does not drop old `bread_kg_*` tables. SQLite does not drop leftover `kg_nodes` or
`kg_edges`. Those tables are not read. An operator drops them.

[`examples/knowledge-graph`](https://github.com/matteozambon89/bread/tree/HEAD/examples/knowledge-graph)
keeps documents on Postgres and sends durable facts through these tools. The extract task returns
names and does not store them.
