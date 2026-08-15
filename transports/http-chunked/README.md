<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/transport-http-chunked

HTTP (chunked NDJSON) [`BreadTransport`](../../docs/transports.md) for [bread](https://github.com/matteozambon89/bread) —
a `mount()`-able server ingress plus a `remoteAgent()` client, speaking the Bread protocol
(`packages/core/src/protocol.ts`) over one HTTP connection. This is the recommended default
transport for `bread dev`/`bread start`.

## Install

```bash
bun add @breadai/transport-http-chunked
```

## Usage

```ts
// bread.config.ts
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['writer'],
  store: store({ path: './bread.db' }),
  transport: transport(), // config.transport.mount(app, bread) wires the routes
})
```

```ts
// Consuming a remote bread instance's mounted routes (config.remoteAgents)
import { remoteAgent } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['local'],
  store: store({ path: './bread.db' }),
  remoteAgents: {
    researcher: remoteAgent({ url: 'http://remote:3000' }),
  },
})
```

## What `mount()` adds

The four routes `createServer()` used to hand-roll, reimplemented generically against the public
`BreadInstance` surface (`run`/`resume`/`runPipeline`/`store.getCrumbs`/`transport.subscribe` —
never anything private):

| Route | Behavior |
|---|---|
| `POST /agents/:id/run` | Runs an agent, streams its crumbs as NDJSON |
| `POST /pipelines/:id/run` | Runs a configured pipeline, streams step + inner-agent crumbs |
| `POST /resume/:checkpointId` | Resumes a suspended HITL run, streams the continuation |
| `GET /runs/:runId/stream` | Passively tails any run — store replay (`Last-Event-ID`/`?after=`) then live |

Each line of a streamed response body is one Bread protocol `CrumbFrame`, JSON-encoded
(`{ v, type: 'crumb', runId, seq, crumb }`), newline-terminated. A failure — including one that
would otherwise throw before the stream even starts, like an unknown pipeline id — surfaces as a
synthetic `agent:error` crumb in the stream rather than tearing down the connection; the HTTP
status stays 200 once headers are sent. Blank lines are heartbeats (skip them).

## Semantics

- `transport()`'s pub/sub + bounded replay is the embedded `streamTransport()` — single-process
  only. Cross-replica fan-out is `@breadai/transport-redis`'s job, not this package's; combining
  Redis fan-out with HTTP ingress on the same `config.transport` slot isn't supported yet (see
  `docs/transports.md`'s known gap).
- `remoteAgent()`'s `run()` is a plain NDJSON line reader — no reconnect/replay logic of its own
  today (a dropped connection just ends the generator).
