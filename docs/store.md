# Storage

bread persists all state through a single **`BreadStore`** interface. Neither core nor the CLI
bundles a database driver — you choose a backend and set it explicitly.

## Configuring a store

Set `store` in `bread.config.ts`:

```ts
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-sqlite'

export default defineConfig({
  entrypoints: ['writer'],
  store: store({ path: './bread.db' }),
})
```

**Postgres:** set `store: store()` — the store reads `DATABASE_URL` itself (the CLI never
touches it). `DATABASE_URL` is a Postgres concern owned by the Postgres store, not by bread.

```ts
import { store } from '@breadai/store-postgres'

export default defineConfig({
  entrypoints: ['writer'],
  store: store(), // reads DATABASE_URL; or store({ url })
})
```

`config.store` is the single source of truth — strict everywhere. An unset `store` is a clear,
immediate error (`STORE_NOT_CONFIGURED`) from every entry point (`bread dev`/`start`/`chat`/
`invoke`/`sessions`, and library callers via `createServer`/`bread.start()`), never a silent
ephemeral fallback or an interactive prompt.

## What is stored

A `BreadStore` covers several concerns uniformly. Sessions, checkpoints, and loops are required;
the crumb log, knowledge graph, document, and task-run methods are optional (a store may omit
them).

| Data | Tables (Postgres) | Notes |
|------|-------------------|-------|
| Sessions + messages | `bread_sessions`, `bread_session_messages` | see [sessions.md](./sessions.md) |
| HITL checkpoints | `bread_checkpoints` | survive restart; see [hitl.md](./hitl.md) |
| Agent-driven loops | `bread_loops`, `bread_loop_iterations` | required; see [loops.md](./loops.md) |
| Crumb log | `bread_crumbs` | optional; per-run crumb history powering `Last-Event-ID` catch-up on `GET /runs/:runId/stream` — `text:delta`s stored aggregated; rows cascade with their session; see [transports.md](./transports.md) |
| Knowledge graph | `bread_kg_nodes`, `bread_kg_edges` | optional |
| Documents | `bread_documents` | optional |
| Task runs (audit) | `bread_task_runs` | optional; see [tasks.md](./tasks.md) |

`migrate()` runs `CREATE TABLE IF NOT EXISTS` at startup, so the schema is created automatically.

## Store packages

| Package | Backend | When to use |
|---------|---------|-------------|
| `@breadai/store-postgres` | PostgreSQL | Recommended for production; `store()` reads `DATABASE_URL` |
| `@breadai/store-sqlite` | SQLite via `bun:sqlite` | Local dev — works out of the box, no external service |
| `@breadai/store-memory` | In-memory | Unit tests, ephemeral runs |

All three implement the same flat `BreadStore`, so swapping is a one-line change to `store`. See the
[`store-showcase`](https://github.com/matteozambon89/bread/tree/HEAD/examples/store-showcase) example for all three side by side.

## Bring your own store

Implement the `BreadStore` interface and pass it as `store`. Sessions and checkpoint methods are
required, including `claimSessionPrincipal` and `deleteSessionForPrincipal`; implement the knowledge/document methods only if your agents use them, and the crumb-log
methods (`appendCrumbs`/`getCrumbs`/`getMaxCrumbSeq`) if you want `Last-Event-ID` catch-up on the
passive run stream (without them, `GET /runs/:runId/stream` degrades to live-tail-only). All
first-party stores implement the full interface.

> [!WARNING]
> Breaking for custom stores: `claimSessionPrincipal(id, principal)` and
> `deleteSessionForPrincipal(id, principal)` are new required methods, and `createSession`,
> `getSession`, and checkpoints now carry `principal`. Both new methods are one conditional write:
> claim only when the row has no principal, delete only when `iss` and `sub` match. Without the
> crumb-log methods, an authenticated caller cannot open `GET /runs/:runId/stream`, because the
> run owner is read from that log. See [Sessions: Ownership](./sessions.md#ownership).
>
> Checkpoints also carry `executionId`. A custom store must save it in `saveCheckpoint` and
> `suspendRun`, filter `listCheckpoints({ executionId })` by it, and refuse an empty id in all three
> with `requireExecutionId` (exported from `@breadai/core`), so a missing id never matches every row.
> See [HITL: one id for the whole execution](./hitl.md#one-id-for-the-whole-execution).
>
> Loop HITL adds `claimCheckpoint(id)`: return the row once and mark it claimed without deleting
> it, so a second call gets `undefined`. `getCheckpoint` still returns a claimed row,
> `saveCheckpoint` must not clear the flag, and only `deleteCheckpoint` removes it. See
> [Loops](./loops.md).

## Semantic (vector) search

`store` accepts an optional `embed` function. When provided, documents and knowledge nodes
are embedded on write and searched by cosine similarity via [pgvector](https://github.com/pgvector/pgvector);
without it, search falls back to keyword (`ILIKE`) matching.

```ts
import { store } from '@breadai/store-postgres'
import { openai } from '@ai-sdk/openai'

store: store({
  embed: async (text) => {
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
    return res.data[0].embedding
  },
})
```

When `embed` is set, `migrate()` also runs `CREATE EXTENSION IF NOT EXISTS vector`. The SQLite and
memory stores are always keyword-only.

## Blob storage

Binary content (file bytes) is a separate, independent seam from `BreadStore` — a `BlobStore`
(`put`/`get`), set via `config.blobStore`. Separate because a blob backend like S3 can't
reasonably implement `BreadStore`'s session/checkpoint/loop contract; `BlobStore` sits alongside
`BreadTransport` as bread's other pluggable seam, not a bolt-on to `store`.

```ts
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-postgres'
import { store as blobStore } from '@breadai/store-s3'

export default defineConfig({
  entrypoints: ['assistant'],
  store: store(),
  blobStore: blobStore({ bucket: 'my-bucket', region: 'us-east-1' }),
})
```

Unlike `store`, `blobStore` is **optional** — there's no `BLOB_STORE_NOT_CONFIGURED` startup throw.
A feature that needs it fails with its own clear, feature-specific error only when it's actually
used without one configured, the same way `BreadStore`'s optional knowledge/document methods
degrade gracefully rather than crashing at startup. Current consumers:

- `@breadai/protocol-a2a-server`'s inline `FilePart` handling (input-side) and output-side `FilePart`
  mapping (see [a2a.md](./a2a.md#files)).
- `@breadai/core`'s runner — a model that generates a file directly (e.g. an image-generation-capable
  model) is stored automatically via `blobStore.put()`; a run with none configured throws a runtime
  `BreadError('BLOB_STORE_NOT_CONFIGURED', ...)` the moment the model actually produces a file, not
  at startup.
- A pipeline `transcription` step throws the same code when `blobStore` is unset. It does not call
  `get` or `put`. It passes the `FileOutput` http(s) `uri` to `transcribe`. See
  [pipelines.md](./pipelines.md#transcription).
- `ToolContext.blobStore` — a tool's own `execute()` can call `ctx.blobStore.put()` directly to
  store a file it generates or fetches; see [tools.md](./tools.md#toolcontext).

`BlobStore.put()` generates its own key (like `ingestDocument` generates its own document id) and
returns a retrievable `url` — for `@breadai/store-s3`, a presigned GET URL. There's no
`@breadai/store-*` in-memory blob implementation published (unlike `BreadStore`'s
`@breadai/store-memory`) since nothing besides tests currently needs one.
