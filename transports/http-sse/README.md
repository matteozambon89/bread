# @bread/transport-http-sse

HTTP (SSE) [`BreadTransport`](../../docs/transports.md) for [bread](https://github.com/matteozambon89/bread) —
a `mount()`-able server ingress plus a `remoteAgent()` client, using Server-Sent Events. The
browser-`EventSource`-friendly alternative to `@bread/transport-http-chunked`; preserves today's
exact wire format (`data: {type,payload}\n\n`, `id: <seq>`, `Last-Event-ID`/`?after=` catch-up), so
existing curl/`EventSource` examples keep working unchanged.

## Install

```bash
bun add @bread/transport-http-sse
```

## Usage

```ts
// bread.config.ts
import { transport } from '@bread/transport-http-sse'

export default defineConfig({
  entrypoints: ['writer'],
  store: store({ path: './bread.db' }),
  transport: transport(),
})
```

```ts
// Consuming a remote bread instance's mounted routes (config.remoteAgents)
import { remoteAgent } from '@bread/transport-http-sse'

export default defineConfig({
  entrypoints: ['local'],
  store: store({ path: './bread.db' }),
  remoteAgents: {
    researcher: remoteAgent({ url: 'http://remote:3000' }),
  },
})
```

## What `mount()` adds

Same four routes as `@bread/transport-http-chunked` (`POST /agents/:id/run`,
`POST /pipelines/:id/run`, `POST /resume/:checkpointId`, `GET /runs/:runId/stream`), reimplemented
generically against the public `BreadInstance` surface — no private config access, so a failure
that would otherwise throw before the stream starts (e.g. an unknown pipeline id) surfaces as an
SSE `{type:'error', payload:{code,message}}` event instead of a 404 or a torn-down connection.

## Semantics

- `transport()`'s pub/sub + bounded replay is the embedded `streamTransport()` — single-process
  only. Cross-replica fan-out is `@bread/transport-redis`'s job (see `docs/transports.md`'s known
  gap on combining the two).
- `remoteAgent()`'s `run()` is a plain SSE line reader — no reconnect/replay logic of its own today.
