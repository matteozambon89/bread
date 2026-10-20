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

Every route has a named action. With `authPlugin()` in `config.plugins` (see
[auth.md](./auth.md)), `createServer` calls `server.authorize(identity, action, args)`
before the handler. `identity` is the `AuthIdentity` that plugin stored. `action` is
one of the actions below. `args` is the path params plus the query params; a path param
wins when the same key appears in both. Return `true` to allow. `false`, or a missing
function, is `403` `{ "error": "Forbidden" }` and the handler does not run.

Bread does not filter a list and does not apply a row predicate. Denying a route is
`403` before the handler. `authorize` may read `args.id` and return `false` for that id.

### Core actions

`@breadai/core` exports `HTTP_ACTIONS`.

| Constant | Route | Allow |
|---|---|---|
| `HTTP_ACTIONS.agentList` | `GET /agents` | Lists the agents. |
| `HTTP_ACTIONS.agentRead` | `GET /agents/:id` | Returns that agent schema. `args.id` is the agent id. |
| `HTTP_ACTIONS.runStart` | `POST /agents/:id/run` | Starts a run of that agent. `args.id` is the agent id. When auth is configured, a missing `identity.principal` is `403`. |
| `HTTP_ACTIONS.pipelineStart` | `POST /pipelines/:id/run` | Starts that pipeline. `args.id` is the pipeline id. When auth is configured, a missing `identity.principal` is `403`. |
| `HTTP_ACTIONS.runResume` | `POST /resume/:checkpointId` | Resumes that checkpoint. `args.checkpointId` is the checkpoint id. Allow does not check who started the run. When auth is configured, a missing `identity.principal` is `403`. When `identity.principal` is set, `resumeVisible` from `@breadai/core` runs before anything is registered: the stored principal must be visible (`iss` and `sub`) and `runVisible` must pass for the suspended run. A checkpoint the caller can't see is the same `404` as a missing one. The resumed run's cancel entries carry the stored principal, not the caller's. |
| `HTTP_ACTIONS.runStream` | `GET /runs/:runId/stream` | Tails that run. `args.runId` is the run id. Allow does not choose which run. When auth is configured, a missing `identity.principal` is `403`. A run started under another principal is the same `404` as an unknown run. `authorizeStream` still runs after that check. |
| `HTTP_ACTIONS.runCancel` | `POST /runs/:runId/cancel` | Cancels that run. `args.runId` is the run id. When auth is configured, a missing `identity.principal` is `403`. A run started or resumed under another principal is the same `404` as an unknown run. `authorizeStream` still runs after that check. |
| `HTTP_ACTIONS.sessionList` | `GET /sessions` | Returns visible sessions when `identity.principal` is set, and every session when it is not. `args.tag` is set when the tag query is present. A tag query only narrows. |
| `HTTP_ACTIONS.sessionRead` | `GET /sessions/:id` | Returns that session. `args.id` is the session id. A missing or hidden session is `404`. |
| `HTTP_ACTIONS.sessionDelete` | `DELETE /sessions/:id` | Deletes that session. `args.id` is the session id. A hidden session returns `{ "ok": true }` and is not deleted. With a principal, the delete matches the id, a non-null principal, and `iss` and `sub` in one store write. |
| `HTTP_ACTIONS.sessionCleanup` | `POST /sessions/cleanup` | Deletes visible sessions in the age window. With no principal, the store cleanup stays unscoped. |
| `HTTP_ACTIONS.loopList` | `GET /loops` | Returns every loop. The `session`, `agent`, and `status` queries only narrow. |
| `HTTP_ACTIONS.loopRead` | `GET /loops/:id` | Returns that loop. `args.id` is the loop id. |
| `HTTP_ACTIONS.taskList` | `GET /tasks` | Returns every task run. The `task`, `session`, `agent`, `status`, and `limit` queries only narrow. |
| `HTTP_ACTIONS.taskRead` | `GET /tasks/:id` | Returns that task run. `args.id` is the task-run id. |

A static segment outranks a param, so `POST /sessions/cleanup` is not `/sessions/:id`.

### Plugin actions

`@breadai/protocol-a2a-server` exports `A2A_ACTIONS`. `@breadai/protocol-ag-ui` exports
`AG_UI_ACTIONS`. `@breadai/protocol-mcp-server` exports `MCP_ACTIONS`. Core does not re-export
them.

| Constant | Route | Allow |
|---|---|---|
| `A2A_ACTIONS.card` | `GET` at `A2AServerConfig.cardPath` | Returns the Agent Card. |
| `A2A_ACTIONS.rpc` | `POST` at the pathname of `A2AServerConfig.url` | Handles one JSON-RPC call. |
| `AG_UI_ACTIONS.run` | `POST` at the `path` option, default `/ag-ui/run` | `authorizeThread` still runs after the grant. When auth is configured, a missing `identity.principal` is `403` before the run. A present principal is copied onto the run. |
| `MCP_ACTIONS.request` | Every method on the `path` option, default `/mcp` | Handles one MCP HTTP request. |

A method of `*` matches every method on that path. A plugin that calls `app.get` or `app.post`
without `registerHttpRoute` leaves an unnamed route, and an unnamed route is `403` when auth is on.

With no plugin named `auth`, `server.authorize` is not called. A request is allowed only
when the `Host` header is loopback (`localhost`, `127.0.0.1`, `::1`, an optional port,
and bracketed `[::1]` / `[::1]:port`). `localhost.`, `127.1`, `0.0.0.0`, and `::` are not
loopback. `X-Forwarded-Host` is ignored. Anything else is `403` `{ "error": "Forbidden" }`.
Those loopback `POST /agents/:id/run` and `POST /pipelines/:id/run` calls stamp
`{ iss: "https://bread.local/cli", sub: "local" }`. `ag-ui.run` does the same when the request
has no identity.

`createServer` itself does not throw, so an in-process `app.request` still runs. The
listen adapters check before the socket opens. No auth and a loopback bind warns that a
reverse proxy on the same machine can present a loopback `Host`, and listens. Every other
combination throws `AUTH_NOT_CONFIGURED` and does not listen: auth without
`server.authorize`, `server.authorize` without auth on a public bind, and neither on a
public bind. See [auth.md#guarding-the-server](./auth.md#guarding-the-server).

`config.server.tls` (`key`, `cert`, and `ca` PEM contents) makes both listen adapters require a verified client certificate. The principal still comes only from a strategy passed to `authPlugin()` — see [mTLS](./auth.md#mtls). Omit `tls` and the bind stays plain HTTP.

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
List agents (`HTTP_ACTIONS.agentList`, [Core actions](#core-actions)). → `[{ id, model, outputFormat }]`

### `GET /agents/:id`
Agent schema (`HTTP_ACTIONS.agentRead`, [Core actions](#core-actions)). → `{ id, model, outputFormat }` · `404` if unknown.

### `POST /agents/:id/run`
Run an agent (`HTTP_ACTIONS.runStart`, [Core actions](#core-actions)), streaming crumbs.

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
  frames only (no catch-up) to an unscoped caller, and the server logs a notice at startup. A
  caller with `identity.principal` gets `404`, because the run owner cannot be read. All first-party stores
  support the log. Conversely, a `sink`-capability transport (no `subscribe`) has no live frames
  to offer — the route serves the store's replay only, then closes.
- **Authorization**: [`HTTP_ACTIONS.runStream`](#core-actions). When auth is configured, a
  missing `identity.principal` is `403`. With a principal, `runVisible` from `@breadai/core` picks
  the run owner before any header is sent: the principal of a run live on this replica, otherwise
  the principal on the run's first logged crumb, `agent:run:start`. A run the caller can't see, a
  run with no owner source, and an unknown run id are all the same `404`. A run with no stored
  principal is visible only to the local CLI principal.
  `transport({ authorizeStream })` on both HTTP transports still runs after that grant.
  `authorizeStream(identity, runId)` receives the `AuthIdentity` `authPlugin()` stashed (`undefined`
  if no auth ran) and the `runId`; `false` is another `403`, sent before any header and before the run's crumbs
  are replayed. `runVisible` may already have read the run's first logged crumb to pick the owner.

## Pipelines

### `POST /pipelines/:id/run`
Run a pipeline (`HTTP_ACTIONS.pipelineStart`, [Core actions](#core-actions)) declared in
`config.pipelines`. Body: `{ "input": ... }`. Streams crumbs including
`pipeline:step:start` / `pipeline:step:end`. An unknown pipeline id is a `PIPELINE_NOT_FOUND`
`error` event in the stream (see [Errors](#errors)), not a `404` — the response status is `200`.

Each step crumb carries its own `runId`, `<pipelineRunId>:<pipelineId>:<stepIndex>`. `pipelineRunId`
is a UUIDv7 minted once per pipeline run, so two runs of the same pipeline never share a step id.
Nested `parallel` and `branch` steps extend the `pipelineId` part, and resume reuses the original
`pipelineRunId`. A step id is live only while its stream runs. Step crumbs are not logged, so after
that `GET /runs/:runId/stream` and `POST /runs/:runId/cancel` answer `404` for it. Older releases
used `<pipelineId>:<stepIndex>`, which is a breaking change for clients that built step ids by hand.

## HITL

### `POST /resume/:checkpointId`
Resume a paused run (`HTTP_ACTIONS.runResume`, [Core actions](#core-actions)). Body: `{ "response": ... }`.
The original `POST /agents/:id/run` stream ends at
the `human:required` crumb; this endpoint **streams the continuation** as its own `text/event-stream`
(`human:resumed` → … → `agent:run:end`). Resume replays the run from the store, so it works after a
restart or on a different instance than the original run. See [hitl.md](./hitl.md).
With auth configured, a checkpoint the caller can't see is `404 { "error": "Checkpoint not found" }`,
the same as a missing one, and nothing runs or registers.

## Sessions

`HTTP_ACTIONS.sessionList`, `HTTP_ACTIONS.sessionRead`, `HTTP_ACTIONS.sessionDelete`, and
`HTTP_ACTIONS.sessionCleanup`. See [Core actions](#core-actions) and
[Ownership](./sessions.md#ownership).

| Endpoint | Body / query | Response |
|----------|--------------|----------|
| `GET /sessions` | `?tag=key:value` | `Session[]` |
| `GET /sessions/:id` | — | `Session` · `404` |
| `DELETE /sessions/:id` | — | `{ ok: true }` |
| `POST /sessions/cleanup` | `{ olderThanDays?, tags? }` | `{ deleted: <count> }` |

## Loops

Agent-driven loops are listed and inspected for reporting; live progress arrives as `loop:*`
crumbs on the agent run's SSE stream. See [loops.md](./loops.md).

`HTTP_ACTIONS.loopList` and `HTTP_ACTIONS.loopRead`. See [Core actions](#core-actions).

| Endpoint | Body / query | Response |
|----------|--------------|----------|
| `GET /loops` | `?session=` · `?agent=` · `?status=` | `LoopRecord[]` |
| `GET /loops/:id` | — | `{ loop: LoopRecord; iterations: LoopIteration[] }` · `404` |

## Task runs

Each one-shot task invocation is recorded for after-the-fact review; live progress arrives as
`task:*` crumbs on the agent run's SSE stream. `501` if the configured store doesn't record task
runs. See [tasks.md](./tasks.md).

`HTTP_ACTIONS.taskList` and `HTTP_ACTIONS.taskRead`. See [Core actions](#core-actions).

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
