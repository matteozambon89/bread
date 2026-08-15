# A2A server — `@breadai/protocol-a2a-server`

Expose a bread agent as an [A2A](https://a2a-protocol.org) (Agent-to-Agent) endpoint: an Agent Card
clients can discover, and a JSON-RPC method that invokes the agent synchronously and returns a
spec-shaped response. Hand-rolled against the raw spec (no `@a2a-js/sdk` dependency — its server
building blocks are Express-specific and don't fit bread's Hono-based plugin model).

```bash
bun add @breadai/protocol-a2a-server
```

## Choosing a spec version

A2A has two live wire formats today. `a2aServer(...)` speaks either, picked per plugin instance via
`specVersion`:

```ts
import { a2aServer } from '@breadai/protocol-a2a-server'

a2aServer({ agentId: 'researcher', url: 'https://api.example.com/a2a', cardPath: '/.well-known/agent-card.json' })                                    // v0.3.x (default)
a2aServer({ agentId: 'researcher', url: 'https://api.example.com/a2a-v1', specVersion: '1.0', cardPath: '/.well-known/agent-card-v1.json' })          // v1.0
```

- **`'0.3'` (default)** — the interoperable version. Every current A2A client/deployment speaks
  this dialect (`message/send`, lowercase enum values, a `kind`-discriminated `Part`).
- **`'1.0'`** — the newer spec (released 2026-03-12). Its JSON-RPC binding only (the spec also
  defines REST and gRPC bindings — not implemented here). Method names are PascalCase/gRPC-style
  (`SendMessage`), enums are `SCREAMING_SNAKE_CASE`, and `Part` drops the `kind` discriminator
  entirely in favor of member-presence (see below). No SDK client treats this as its default yet —
  pick it only if you know your caller specifically targets v1.0.
- **`cardPath`** — required, not defaulted. It's the path this mount's Agent Card is served at.
  Exposing the same agent under both versions (or exposing two different agents) in the *same*
  process means mounting `a2aServer(...)` twice — each mount's RPC endpoint is already distinct
  (different `url`), but every mount needs its own `cardPath` too, or the second one's Card is
  never reachable: Hono serves only the first handler registered at a given path, silently, with
  no error. A single-mount deployment should just use the spec's standard well-known location,
  `/.well-known/agent-card.json`.

## Agent Card discovery

Each mount serves its Card at its own `cardPath` — conventionally `GET
/.well-known/agent-card.json`, the spec's well-known location, for a deployment's primary (or
only) mount; a second same-process mount needs a distinct path (see above).

The two versions' Card *shapes* differ:

- **v0.3** — flat `url`, `protocolVersion: "0.3.0"`, `capabilities: {streaming, pushNotifications,
  stateTransitionHistory}`.
- **v1.0** — `supportedInterfaces: [{url, protocolBinding: "JSONRPC", protocolVersion: "1.0"}]`
  replaces the flat `url`; `capabilities: {streaming, pushNotifications, extendedAgentCard}`.

Both versions populate `name`/`description`/`skills` the same way: `name` defaults to the agent id,
`description` falls back to the first line of the agent's `prompt.md`-sourced system prompt (or a
generic `Agent "<id>"` string if that's empty), and `skills` comes from the agent's loaded
`SKILL.md` metadata — falling back to one synthetic skill entry (from the agent id) when the agent
has none. `defaultInputModes`/`defaultOutputModes` are always `['text/plain']`, even though `text`
and `data` parts are both accepted on the wire (see below) — the Card doesn't yet advertise
`application/json` as a supported mode.

## Invoking the agent

**v0.3 — `message/send`:**

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": { "role": "user", "parts": [{ "kind": "text", "text": "hi" }], "messageId": "m1", "kind": "message" } }
}
```

**v1.0 — `SendMessage`:** same envelope, PascalCase method, no `kind` field — a `Part` is
identified by which key is present (`text`/`raw`/`url`/`data`; `text` and `data` are accepted,
`raw`/`url` — file parts — are not):

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
  "params": { "message": { "role": "ROLE_USER", "parts": [{ "text": "hi" }], "messageId": "m1" } }
}
```

If porting a v0.3 client call to v1.0, the `kind: "text"` discriminator disappearing is the
sharpest gotcha — a v1.0 part with an accidental `kind` field is just an extra ignored property, not
an error, so a silently-wrong request can look fine until you check the response.

Both versions accept `text`, `data`, and `file` parts (`kind`-discriminated in v0.3, member-presence
in v1.0). A URI-referenced file part is always accepted (`file.fileWithUri` in v0.3, `url` in
v1.0); an inline-bytes file part (`file.fileWithBytes` in v0.3, `raw` in v1.0, both base64) is
accepted only when `config.blobStore` is set — see [Files](#files) below. How a message's parts
become the agent's `input` via `bread.run(agentId, input, { mode: 'sync' })` depends on the mix:

- **All parts are text** (one or more) — joined with `\n` into a single string, exactly as before
  data/file parts existed.
- **Exactly one part, and it's a data part** — its parsed JSON object is passed directly as `input`.
- **Exactly one part, and it's a file part** — `input` becomes `{ uri, mimeType?, name? }`, `uri`
  being either the client-provided URI or, for inline bytes, the URL `blobStore.put()` returned.
- **Any other mix involving a data or file part** (text alongside data/file, or more than one
  non-text part) — `input` becomes an ordered array of tagged parts, e.g.
  `[{ "text": "hi" }, { "data": { "a": 1 } }, { "file": { "uri": "..." } }]`, preserving wire order.
  This avoids the ambiguity of joining a `JSON.stringify`-ed data part into a `\n`-separated string
  alongside text that might itself contain newlines.

## Files

A `FilePart` maps to the canonical shape `{ uri, mimeType?, name? }` regardless of spec version or
whether it arrived by reference or as inline bytes:

- **URI-referenced** (`file.fileWithUri`/`url`) — bread never fetches or stores the bytes; `uri` is
  passed through verbatim. No `blobStore` needed.
- **Inline bytes** (`file.fileWithBytes`/`raw`, base64) — requires `config.blobStore` (see
  [store.md](./store.md#blob-storage)); bread decodes and uploads via `blobStore.put()`, then uses
  the returned `url` as `uri`. Rejected with `-32602` if `blobStore` isn't configured, or if the
  base64 payload exceeds a 10 MB decoded-size limit (checked before decoding) — either way, the
  error names which case applies.

`@breadai/core`'s runner JSON-serializes any non-string `input` into the model prompt automatically
(`typeof input === 'string' ? input : JSON.stringify(input)`) — the same path
`@breadai/protocol-mcp-server` already uses for structured input — so passing an object or array here
needs no protocol-specific serialization code. If a model prefers a different format than JSON (CSV,
XML, ...), a per-agent `beforeRun` hook can reformat `input` into a string before it reaches this
step; see [agents.md](./agents.md) — no `a2a-server`-specific config exists for this.

### Output-side files

An agent can hand back a file two ways:

- **A model generates one directly** — a multimodal model (e.g. `gemini-2.5-flash-image-preview`)
  emitting an image as part of its own generation, independent of any tool call. `@breadai/core`'s
  runner stores it automatically via `config.blobStore` and emits a `file:generated` crumb per file
  (see [store.md](./store.md#blob-storage)); a run with no `blobStore` configured throws
  `BLOB_STORE_NOT_CONFIGURED` rather than silently dropping the file.
- **A tool stores one and the agent echoes the reference** — a tool calls `ctx.blobStore.put()`
  itself (see [tools.md](./tools.md)) and returns a reference; the agent's own final output then
  needs to be shaped `{ kind: 'file', uri, mimeType?, name? }` (a `CustomFormat` `output.format` is
  the only path that gets both tool access and a caller-controlled final parse — `'json'`-format
  agents never receive `tools`, so they can't call one in the same run).

Either way, `message/send`/`SendMessage`'s response `Message.parts` carries a real `FilePart` —
`{"kind":"file","file":{"fileWithUri":...}}` in v0.3, `{"url":...,"mediaType":...}` in v1.0 — model-
generated files first (0 or more), then the agent's own output if it's file-shaped. A string output
still becomes a `text` Part and any other object still becomes a `data` Part, exactly as before;
these are independent slots, so a run can return both a generated file and explanatory text in the
same response. See [Streaming](#streaming) for how this maps over `message/stream`/
`SendStreamingMessage`.

**Limitation:** a message mixing text and data parts (or more than one data part) still collapses to
the tagged-parts array above rather than being routed through the agent's `inputSchema` — the schema
is never consulted to decide how parts combine, only a single data part maps directly to a
schema-shaped object.

## Streaming

**v0.3 — `message/stream`:** same request shape as `message/send`, different `method`. The response
is `200 OK`, `Content-Type: text/event-stream`. Every SSE frame's `data:` is a full JSON-RPC 2.0
envelope wrapping one streaming event: `{"jsonrpc":"2.0","id":<request id>,"result":<event>}`.

**v1.0 — `SendStreamingMessage`:** same idea, v1.0's oneof-wrapped, `TASK_STATE_*`-enum event shapes.

Input-side, `message/stream`/`SendStreamingMessage` accepts the same `text`/`data` part mix as
`message/send`/`SendMessage` (they share the same part-extraction logic) — a single data part is
passed as `input` directly. Output-side, file output now streams: a model-generated file surfaces
live as an `artifact-update` file part the instant it's stored (from the `file:generated` crumb),
and a tool-echoed `FileOutput`-shaped agent output surfaces as one immediately before the terminal
status update. **JSON/data output still doesn't stream** — the agent's incremental `text:delta`
output remains the only *text* content surfaced as artifact updates, and there's still no "final
structured output" crumb for a non-file, non-string result, so a `'json'`-format agent's structured
result still isn't representable over this event sequence. That narrower gap is unchanged — a
`@breadai/core` runner limitation, not something this protocol package can work around.

The event sequence is always: one initial `Task` (`kind:'task'` for v0.3, `{task:{...}}` for v1.0,
`status.state` "working"/`TASK_STATE_WORKING`), then zero or more artifact updates as the agent's
text streams in (`kind:'artifact-update'` / `{artifactUpdate:{...}}`, one artifact for the whole run,
`append:false` on the first chunk then `true`), then one final status update
(`kind:'status-update'` / `{statusUpdate:{...}}`, `state:"completed"`/`TASK_STATE_COMPLETED` on
success or `"failed"`/`TASK_STATE_FAILED` on error, always `final:true`) — the connection closes
right after. `lastChunk` on artifact updates is always `false`; the terminal status update's
`final:true` is the real end-of-stream signal, not a per-artifact one.

`taskId` is the underlying bread `runId` — a real, unique id. Unlike a dropped connection with no
way back in, `tasks/resubscribe`/`SubscribeToTask` (below) can reattach to it later by id.

**Gap carried over from this section, not new this round:** the live stream never emits an event
for `human:required` (HITL suspension) — the connection just goes quiet until the run resumes or
ends. `input-required` is only observable via `tasks/get`/`GetTask` or a `tasks/resubscribe`/
`SubscribeToTask` replay (below), not on the original `message/stream`/`SendStreamingMessage`
connection.

## Task lifecycle

**v0.3 — `tasks/get`:**

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tasks/get", "params": { "id": "<taskId>" } }
```

**v1.0 — `GetTask`:** same params shape (`historyLength` is accepted but ignored — see below).

Both return a `Task` with a status derived fresh from the task's crumb log — there's no persisted
task registry, so this is a live scan of `bread.store.getCrumbs(taskId)` every call:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "id": "<taskId>", "contextId": "<taskId>", "status": { "state": "working" } } }
```

`state` is one of `submitted`/`working`/`input-required`/`completed`/`failed` (v0.3) or the
matching `TASK_STATE_*` (v1.0) — `input-required` reflects an in-flight HITL suspension. The
response has **no `artifacts`/`history` array** — this implementation returns status only, not a
reconstruction of the run's output or event history, so `stateTransitionHistory`/
`AgentCapabilities` stays `false`/absent on the Agent Card. An unknown `id` returns
`TaskNotFoundError` (`-32001`).

**v0.3 — `tasks/resubscribe`:**

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tasks/resubscribe", "params": { "id": "<taskId>" } }
```

**v1.0 — `SubscribeToTask`:** same params shape.

Reattaches to a run's SSE stream: replays the crumb log from `Last-Event-ID` (header) / `?after=`
(query fallback) / `0` (default — full replay) forward, then tails live frames via the transport,
same event shapes and `id:`-per-frame framing as `message/stream`/`SendStreamingMessage`. The
`artifactId` on a resumed artifact update is stable across reconnects (seeded from `taskId`, not a
fresh random id per connection), so a client's partial-artifact accumulation survives a reconnect.
An unknown `id` returns `TaskNotFoundError` (`-32001`); resubscribing to an already-`completed`/
`failed` task returns `UnsupportedOperationError` (`-32004`) instead of opening a stream.

The response always writes an immediate `: connected` SSE comment before anything else, even when
the replay has nothing to send (e.g. reconnecting right after a `human:required` with no further
activity yet) — otherwise a client could see no response bytes at all, not even headers, until the
next real event or the 15s heartbeat ping.

**v0.3 — `tasks/cancel`:**

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tasks/cancel", "params": { "id": "<taskId>" } }
```

**v1.0 — `CancelTask`:** same params shape, `TASK_STATE_CANCELED` instead of `canceled`.

Only ever cancels a task that's still live **and was started via this same `a2aServer()`
instance's own `message/stream`/`SendStreamingMessage`** — an in-memory `Map<taskId,
AbortController>`, scoped to the plugin instance, is populated the moment a stream's first crumb
reveals its `runId`. A synchronous `message/send`/`SendMessage` task can never be cancelled this
way: its caller has no way to learn the `taskId` until the run has already finished, so there is no
window in which cancelling it would mean anything — the same constraint `tasks/get`/
`tasks/resubscribe` already have (both need a `taskId` learned from a prior streaming response to
be useful at all). Calling `tasks/cancel`/`CancelTask` on a task that's still active per its crumb
log but was never registered this way (e.g. a run started directly via `bread.run()`, bypassing this
plugin) returns `TaskNotCancelableError` (`-32002`), same as an already-terminal task.

A successful cancel returns an optimistic `Task` with `state: "canceled"`/`TASK_STATE_CANCELED`
immediately — per spec, cancellation is "attempted, success is not guaranteed," so the response
doesn't wait for the crumb log to catch up with the abort. The still-open `message/stream`/
`SendStreamingMessage` connection's own final `status-update`/`statusUpdate` event reflects the same
`canceled`/`TASK_STATE_CANCELED` state once the run actually unwinds (distinguished from a generic
`failed`/`TASK_STATE_FAILED` by the underlying `BreadError`'s `RUN_CANCELLED` code — see
[agents.md](./agents.md)'s Cancellation section for the `@breadai/core` mechanism this rides on). A
follow-up `tasks/get`/`GetTask` call confirms the same state once that lands.

## Errors

Both versions return JSON-RPC protocol-level errors (HTTP 200, `{jsonrpc, id, error: {code,
message}}`) **for the sync methods, and for streaming requests that fail before the SSE response
starts** (bad params, unknown method, parse errors):

| Code | Meaning | Trigger |
|---|---|---|
| `-32700` | Parse error | Request body isn't valid JSON |
| `-32600` | Invalid Request | Missing/wrong `jsonrpc`/`method` field |
| `-32601` | Method not found | Anything but `message/send`/`message/stream`/`tasks/get`/`tasks/resubscribe`/`tasks/cancel` (v0.3) or their v1.0 equivalents |
| `-32602` | Invalid params | No parts; an unrecognized part (none of `text`/`data`/`file`); a `data` part whose data isn't a JSON object; an inline-bytes file part over the 10 MB limit, or with no `blobStore` configured; a `tasks/get`/`tasks/resubscribe`/`tasks/cancel` call with no string `id`; a malformed `Last-Event-ID`/`after` |
| `-32603` | Internal error | The agent run threw — the real error is logged server-side only |
| `-32001` | `TaskNotFoundError` | `tasks/get`/`tasks/resubscribe`/`tasks/cancel` (or v1.0 equivalents) called with an id that isn't a known task |
| `-32002` | `TaskNotCancelableError` | `tasks/cancel`/`CancelTask` called on an already-terminal task, or one this instance never registered (see above) |
| `-32004` | `UnsupportedOperationError` | `tasks/resubscribe`/`SubscribeToTask` called on an already-terminal (`completed`/`failed`/`canceled`) task |

Once a `message/stream`/`SendStreamingMessage` response has started (headers already sent as `200`),
a run failure can no longer be a JSON-RPC HTTP error — it surfaces instead as the final
`status-update`/`statusUpdate` event, `state:"failed"`, with a sanitized `{code, message}` (no raw
stack/cause) in its `status.message`.

## Transport and auth

The route needs **no auth code of its own**. `createServer()` runs every plugin's `middleware` hook
before any plugin's `routes()` are mounted, so if you've wired an auth plugin (e.g. `authPlugin(...)`
from [auth.md](./auth.md)), both the Agent Card and the RPC endpoint are gated exactly like any
other route — no special-casing on a2a-server's part.

**Caveat:** unlike most public A2A deployments (which typically leave the Card itself open for
discovery), bread's auth gate is a blanket `app.use('*', ...)` with no route-type awareness — so an
authenticated deployment gates the Card too. Callers need credentials just to discover the agent.

## What's not implemented yet

- Push notifications / webhooks
- v1.0's REST and gRPC transport bindings (JSON-RPC only, both versions)
- Inline-bytes `FilePart` without a `blobStore` configured — rejected with `-32602`, not silently
  dropped (see [Files](#files) above). URI-referenced `FilePart`, and inline-bytes with a
  `blobStore` configured, are both implemented.
- Streaming JSON/`data` output — see [Streaming](#streaming) above; file output does stream.
