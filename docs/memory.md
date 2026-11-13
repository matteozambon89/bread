# Memory — `@breadai/memory`

`memory()` is a `BreadPlugin`. An agent opts in with `plugins: { memory: {} }`.
`null` and `false` leave the tools off. Core does not attach them. Nothing is copied into a later run's prompt.

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
not choose the backend or the owner.

## Backends

| `kind` | Fields | Recall | `STORE_NO_MEMORY` |
|--------|--------|--------|-------------------|
| `store` | `store` | store search | yes |
| `graph` | `graph`, `store` | package Cypher on `:BreadMemory` | no |
| `combined` | `store`, `graph` | store search | yes |

`store` is the `BreadStore` from [store.md](./store.md). `graph` is the same `Graph` as
[graph.md](./graph.md). This package does not import a driver and does not register
`config.graphCatalog`. The model never sends Cypher.

A graph backend uses `store` only for `getMessages` during dream. `memory()` does not require
memory methods on that store.

Combined writes the store first, then a `:BreadMemory` node with the same id. If that graph write
throws, the store row stays. There is no delete and no retry. Recall does not call `Graph.run`, so
a Postgres `embed` still applies on combined recall. The graph copy is not what recall reads.

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
`content` on the run stream. A graph `memorize` writes `:BreadMemory` without ask. `Graph.run` does
not ask on its own.

## Scope

Every read and write uses `ctx.agentId` plus `ctx.principal.iss` and `ctx.principal.sub`, taken
from the run. Tool arguments cannot set them. Equality is exact: `iss` and `sub` are not
case-folded, and tenant is not an ownership key. Two tenants with the same `iss` and `sub` share
memories, the same way they share sessions.

Graph calls pass `$agentId`, `$iss`, and `$sub` on every statement. They do not pass `tenant`,
`subject`, or `sessionId`. Those predicates are in the statement, not only in the parameters.

A missing principal throws `MEMORY_PRINCIPAL_REQUIRED` with `{ agentId, runId }`. The store never
inserts an unscoped row, and the graph is not called. `forget` deletes only when the id and that
owner match, and returns `{ deleted: false }` otherwise.

Loopback without auth and MCP stdio still share one stamped principal, so they share one memory
bucket. There is no session column. Deleting a session does not delete memories.

## Graph statements

Label `BreadMemory`. Properties are `id`, `content`, `agentId`, `principalIss`, `principalSub`, and
`createdAt` (epoch milliseconds). There is no relationship type.

Every statement is a static string. It matches `agentId`, `principalIss`, and `principalSub` before
`RETURN`. Content, the query, ids, and the principal fields are parameters. Create is `MERGE` on
`id` with `ON CREATE SET` only, then that owner `WHERE`. An existing id owned by someone else
returns no row and throws `MEMORY_GRAPH_OWNER` with `{ agentId }` only. That node's properties are
not changed and are not returned. An empty result with `truncated: true` is not that error. The
write can already have committed, and the row was dropped for size. Create returns the record it
sent. The next dream does not write that id again.

Search is `toLower(content) CONTAINS toLower($query)`, newest first, default limit 10. It does not
embed. List is the same owner filter without `CONTAINS`, default limit 100. Delete captures `id`,
then `DETACH DELETE`. Neo4j will not read a property of a node deleted in that query. Orphan
cleanup collects the matches and deletes them with `FOREACH`, then returns one row, so the driver
row cap does not stop the delete. Reads use `read`. Creates and deletes use `write`. `ctx.signal`
is the fourth argument to `Graph.run`.

A row that is not `{ id, content, createdAt }` throws `MEMORY_GRAPH_ROW`. The message is fixed. It
has no context and no cause. `truncated` does not throw. The rows that came back are returned. This
package does not raise the driver cap. The cap counts returned rows, not nodes a write already
changed, so the owner predicate has to be in the statement.

## Search

`searchMemories` on a store backend defaults `limit` to 10. `listMemories` defaults it to 100 and
never embeds. Both return newest first on the keyword path. Search matches `content` only.

SQLite (`content LIKE`) and `@breadai/store-memory` (`includes`, case-insensitive) are keyword-only.
They take no `embed` option. Postgres uses the same embed path as documents when `embed` is set:
memory write embeds `content`, memory search embeds the query and ranks with `<=>`. That vector
predicate still requires `agent_id`, `principal_iss`, `principal_sub`, and `embedding IS NOT NULL`.
Without `embed`, Postgres search is `content ILIKE`. A ref is resolved on those operations, not at
import. See [store.md](./store.md#semantic-vector-search).

Combined recall uses that store search. A graph backend uses the Cypher above and does not embed.

## Dream

`model` is a `LanguageModel`, or `() => LanguageModel | Promise<LanguageModel>`, so
`bread.config.ts` can stay sync. Dream calls that factory. It does not use the agent model.

After ask, dream reads up to 100 memories for this owner and the last 50 session messages
(`getMessages` is oldest first, by `ctx.sessionId` only). On a combined backend it then repairs the
graph before the model runs. For each of those 100 rows it creates a `:BreadMemory` node when that
id is missing. A row dropped for size is not missing. `ON CREATE SET` does not overwrite a node
that is already there. It also deletes this owner's graph nodes whose ids are not in the store,
when `listMemories` returns fewer than 1000 rows. That list is not the dream page: a node with no
store row is not on the page. A result of 1000 may be incomplete, so that delete is skipped. A
node that still has a store row is not deleted.

`generateObject` uses `maxRetries: 0` and the run's `AbortSignal`. It writes every new row first,
then forgets ids that were in the loaded page. An id outside that page, including another caller's
id, is ignored. A failed forget leaves the new row and the old row. The result is
`{ written, forgotten }`.

Combined forget deletes the owned graph node first, then the store row. If the graph delete throws,
the store row stays and the error propagates. `{ deleted: true }` is not returned. If the store
delete throws after the graph node is gone, the store row stays. The next dream creates that id's
node again when the row is in the newest 100.

A model or factory failure, or a signal that is already aborted, throws `MEMORY_DREAM_FAILED`.
The message is fixed. Context is `{ agentId, runId }` only. The prompt and memory text are not put
on the error. A store or graph error is not wrapped in that code. A graph repair failure is the
graph error, and dream writes no new store row in that case.

A store or combined backend whose store is missing `addMemory`, `searchMemories`, `listMemories`,
or `forgetMemory` throws `STORE_NO_MEMORY` with `{ missing }` when `memory()` is called. A graph
backend does not.

## Leftover knowledge-graph tables

`migrate()` does not drop old `bread_kg_*` tables. SQLite does not drop leftover `kg_nodes` or
`kg_edges`. Those tables are not read. An operator drops them.

[`examples/knowledge-graph`](https://github.com/matteozambon89/bread/tree/HEAD/examples/knowledge-graph)
keeps documents on Postgres and sends durable facts through these tools. The extract task returns
names and does not store them.
