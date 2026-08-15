# HTTP API

`bread dev` and `bread start` serve a Hono app. The four streaming routes below (`/agents/:id/run`,
`/pipelines/:id/run`, `/resume/:checkpointId`, `/runs/:runId/stream`) are mounted by whichever
`config.transport` you pick — the wire format follows from that choice, not from `@breadai/server`
itself:

- **`@breadai/transport-http-sse`** (recommended if you need browser `EventSource` support, and the
  wire-compatible choice if you're relying on bread's original hand-rolled SSE routes): each
  message is `data: { "type": <crumbType>, "payload": <crumb> }\n\n`, preceded by an `id: <seq>`
  field — the crumb's per-run monotonic log position, usable as `Last-Event-ID` on the passive run
  stream below. The examples on this page use this format.
- **`@breadai/transport-http-chunked`** (recommended default otherwise): each line of the response
  body is one Bread protocol `CrumbFrame` — `{ "v": 1, "type": "crumb", "runId", "seq", "crumb"
  }\n` — NDJSON, not SSE. See that package's README for its exact shape.

Every non-streaming route below (`/agents` listing, `/sessions*`, `/loops*`, `/tasks*`) is
transport-agnostic and behaves identically either way.

## Authentication

Bread applies no default posture — a server with no auth plugin serves every request unguarded.
Add one via `@breadai/server`'s `authPlugin()` (see [auth.md](./auth.md)) if you want every route
below to require it. Binding a non-loopback host with no `middleware`-registering plugin at all
prints a loud startup warning (never a gate) — see
[auth.md#guarding-the-server](./auth.md#guarding-the-server).

## Limits

`createServer` applies a global request body-size cap (Hono's `bodyLimit`) ahead of every route,
plugin middleware, and transport-mounted route — default **1 MB**, overridable via
`config.server.maxBodyBytes`. A body over the limit gets `413` with
`{ "error": { "code": "BODY_TOO_LARGE", "message": "..." } }`.

Rate limiting and global concurrency protection are deliberately **not** built in — this is a
framework, not a deployment. Front the server with a gateway or rate limiter (e.g. Cloudflare,
nginx, an API gateway) if you need per-caller throttling.

## Errors

Clients only ever see `{ code, message }` — stack traces, causes, and error context stay
server-side. A failed streaming run ends with a terminal `error` event (SSE) — including for an
unknown agent/pipeline id: neither streaming route 404s, since mounting has no private access to
pre-validate ids against the config, so the failure surfaces in the stream instead, HTTP status 200:

```
data: {"type":"error","payload":{"code":"UNKNOWN_PROVIDER","message":"..."}}
```

`@breadai/transport-http-chunked` carries the same failure as a synthetic `agent:error` `CrumbFrame`
instead of a `type:'error'` sidecar — everything on that wire is a real `BreadCrumb`.

`agent:error` / `tool:error` crumb payloads carry the same sanitized `error` shape. Non-streaming
routes return `{ "error": { code, message } }` with status `500`.

## Agents

### `GET /agents`
List agents. → `[{ id, model, outputFormat }]`

### `GET /agents/:id`
Agent schema. → `{ id, model, outputFormat }` · `404` if unknown.

### `POST /agents/:id/run`
Run an agent, streaming crumbs.

```jsonc
// request body
{
  "input": { "topic": "bread" },          // any JSON, validated by the agent's inputSchema
  "session": { "id": "user-42", "tags": { "user": "42" } },  // optional
  "skill": "deep-research"                  // optional caller-driven skill
}
```

Response: `text/event-stream` of crumbs ending in `agent:run:end` (or `agent:error`).

```
id: 1
data: {"type":"agent:run:start","payload":{...}}
id: 1
data: {"type":"text:delta","payload":{"delta":"Bread is "}}
id: 3
data: {"type":"agent:run:end","payload":{"output":"..."}}
```

`text:delta` events repeat the last durable id (a *watermark*) — deltas are aggregated before
being persisted to the crumb log, so they hold no log position of their own.

### `GET /runs/:runId/stream`
Passively tail a run **without initiating it** — from any replica sharing the same store and
transport. Missed history is replayed from the durable crumb log, then live frames take over:

- **Catch-up**: send `Last-Event-ID: <seq>` (or `?after=<seq>`) with the last id you saw; the
  gap replays first. Aggregated deltas replay as ordinary (larger) `text:delta` events.
- **Reconnects**: the stream opens with `retry: 3000`; browsers' `EventSource` reconnects with
  `Last-Event-ID` automatically. Delivery is **at-least-once** — a reconnect may re-deliver up
  to one in-flight delta window.
- **Lifecycle**: a `: ping` comment every 15s keeps proxies from idling the connection. The
  stream stays open across `human:required` (a resume on *any* replica flows back in — see
  [hitl.md](./hitl.md)) and closes after a terminal crumb (`agent:run:end` / `agent:error`).
  Don't reconnect after a terminal crumb.
- **Degradation**: if the configured store lacks the crumb-log methods, the route serves live
  frames only (no catch-up) and the server logs a notice at startup. All first-party stores
  support the log. Conversely, a `sink`-capability transport (no `subscribe`) has no live frames
  to offer — the route serves the store's replay only, then closes.
- **Authorization**: opt-in via `transport({ authorizeStream })` (both `@breadai/transport-http-chunked`
  and `@breadai/transport-http-sse`). `authorizeStream(identity, runId)` receives whatever
  `authMiddleware`/`authPlugin()` stashed as the caller's `AuthIdentity` (`undefined` if no auth
  ran) and the requested `runId`; returning/resolving `false` responds `403` before any crumb is
  read. No `authorizeStream` configured → unchanged, unauthorized-by-default behavior — this route
  otherwise has no ownership check, so any caller who knows a `runId` can tail it.

## Pipelines

### `POST /pipelines/:id/run`
Run a pipeline declared in `config.pipelines`. Body: `{ "input": ... }`. Streams crumbs including
`pipeline:step:start` / `pipeline:step:end`. An unknown pipeline id is a `PIPELINE_NOT_FOUND`
`error` event in the stream (see [Errors](#errors)), not a `404` — the response status is `200`.

## HITL

### `POST /resume/:checkpointId`
Resume a paused run. Body: `{ "response": ... }`. The original `POST /agents/:id/run` stream ends at
the `human:required` crumb; this endpoint **streams the continuation** as its own `text/event-stream`
(`human:resumed` → … → `agent:run:end`). Resume replays the run from the store, so it works after a
restart or on a different instance than the original run. See [hitl.md](./hitl.md).

## Sessions

| Endpoint | Body / query | Response |
|----------|--------------|----------|
| `GET /sessions` | `?tag=key:value` | `Session[]` |
| `GET /sessions/:id` | — | `Session` · `404` |
| `DELETE /sessions/:id` | — | `{ ok: true }` |
| `POST /sessions/cleanup` | `{ olderThanDays?, tags? }` | `{ deleted: <count> }` |

## Loops

Agent-driven loops are listed and inspected for reporting; live progress arrives as `loop:*`
crumbs on the agent run's SSE stream. See [loops.md](./loops.md).

| Endpoint | Body / query | Response |
|----------|--------------|----------|
| `GET /loops` | `?session=` · `?agent=` · `?status=` | `LoopRecord[]` |
| `GET /loops/:id` | — | `{ loop: LoopRecord; iterations: LoopIteration[] }` · `404` |

## Task runs

Each one-shot task invocation is recorded for after-the-fact review; live progress arrives as
`task:*` crumbs on the agent run's SSE stream. `501` if the configured store doesn't record task
runs. See [tasks.md](./tasks.md).

| Endpoint | Body / query | Response |
|----------|--------------|----------|
| `GET /tasks` | `?task=` · `?session=` · `?agent=` · `?status=` · `?limit=` | `TaskRunRecord[]` |
| `GET /tasks/:id` | — | `TaskRunRecord` · `404` |

## Consuming the stream

```ts
const res = await fetch('http://localhost:3000/agents/writer/run', {
  method: 'POST',
  body: JSON.stringify({ input: { topic: 'bread' } }),
})
const reader = res.body!.getReader()
const dec = new TextDecoder()
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  for (const line of dec.decode(value).split('\n\n')) {
    if (line.startsWith('data: ')) {
      const { type, payload } = JSON.parse(line.slice(6))
      if (type === 'text:delta') process.stdout.write(payload.delta)
    }
  }
}
```
