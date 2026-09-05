# Remote agents

A **remote agent** lets `bread.run(agentId, …)` dispatch to an agent running on *another* bread
server instead of the local registry. The remote runs the agent (its own model, tools, store) and
streams crumbs back; the local process relays them as if the run had happened in-process.

Register remote agents under `remoteAgents` in your config, keyed by the id callers will use:

```ts
// bread.config.ts
import { remoteAgent } from '@breadai/transport-http-chunked'
import { signer } from '@breadai/auth-api-key'

export default defineConfig({
  entrypoints: ['planner'],
  remoteAgents: {
    researcher: remoteAgent({
      url: 'http://research-svc:3000',
      signer: signer({ keys: [process.env.RESEARCH_TOKEN!], scheme: 'Bearer' }),
    }),
  },
})
```

`signer` accepts any `BreadSigner` — e.g. `@breadai/auth-api-key`'s or `@breadai/auth-oauth2`'s
`signer(...)`. Signing runs on **every outgoing request**, so refreshing credentials (e.g.
oauth2's cached client-credentials token) stay valid across long-lived processes. Static
`headers` are merged in before signing.

Now `bread.run('researcher', input)` streams the remote agent's crumbs. A remote id **shadows** the
local registry and does **not** need a matching local agent — the lookup checks `remoteAgents` first.

## How dispatch works

A registered value is a `RemoteAgent` — anything with a `run(agentId, input, opts?)` that yields
`BreadCrumb`s. `@breadai/transport-http-chunked`'s `remoteAgent()` is the reference implementation: it
`POST`s to the remote's `/agents/:id/run` endpoint (mounted there by the same package's `transport()`)
and decodes each NDJSON line — one Bread protocol `CrumbFrame` per line — back into a crumb.
`@breadai/transport-http-sse`'s `remoteAgent()` is the SSE-wire equivalent, for a remote mounted with
that package instead.

```mermaid
flowchart LR
  caller["bread.run('researcher', input)"] --> runner{runAgent}
  runner -->|id in remoteAgents| ra["RemoteAgent.run()<br/>(remoteAgent())"]
  runner -->|else| registry[local agent registry]
  ra -->|HTTP POST /agents/researcher/run| remote[(remote bread server, mount()-ed)]
  remote -->|NDJSON/SSE crumb stream| ra
  ra -->|relayed crumbs| cp[choke point → listeners, bus, caller stream]
```

Relayed crumbs pass through the local instance's choke point like any other run's — **not
verbatim**: the choke point's crumb-log writer always reassigns `seq` from the local instance's own
per-run counter, so a relayed crumb's seq on the local stream never matches whatever seq (if any) it
carried on the remote side. `bread.on('crumb', …)` observers, bus subscribers, and HTTP clients see
remote progress just like a local run's.

## Writing a transport

A transport's `remoteAgent()` is just one implementation. Any object satisfying `RemoteAgent` works
— e.g. a queue, gRPC, or in-process stub for tests:

```ts
import type { RemoteAgent } from '@breadai/core'

const echo: RemoteAgent = {
  async *run(agentId, input) {
    yield { type: 'text:delta', agentId, runId: 'r', sessionId: 's', timestamp: Date.now(), delta: String(input) }
  },
}
```

The connection config (`{ url, headers?, signer? }`) passed into a transport's `remoteAgent()` is not
itself a `RemoteAgent` — it's that transport's own options type (e.g.
`HttpChunkedRemoteAgentOptions`).

A `RemoteAgent` that holds connections (an event-bus broker, a persistent socket) can declare
optional `init()`/`close()` — `bread.start()` awaits every registered one's `init` (after plugin
init) and `bread.stop()` awaits `close`. `remoteAgent()` from either HTTP transport is connectionless
and declares neither.

## Cancellation

`bread.run('researcher', input, { signal })` forwards the signal all the way to the remote server —
aborting stops the remote's underlying agent run, not just the local read:

```ts
const controller = new AbortController()
const run = bread.run('researcher', input, { signal: controller.signal })
setTimeout(() => controller.abort(), 5000)
```

Cancellation is its own explicit signal, not a side effect of the connection dropping — a dropped
connection and a deliberate cancel are indistinguishable at the HTTP layer, so conflating them would
either kill runs on every transient network blip or fail to stop a run the caller actually meant to
cancel. Both `@breadai/transport-http-chunked` and `@breadai/transport-http-sse`'s `remoteAgent()`
attach the signal to the local `fetch()` (so the local iterator throws `RUN_CANCELLED` immediately,
per [agents.md](./agents.md)'s Cancellation section) *and*, best-effort, POST to
`` `${url}/runs/${runId}/cancel` `` — their `mount()`-ed routes keep a per-run `AbortController` in an
in-memory registry (the same pattern `@breadai/protocol-a2a-server`'s `tasks/cancel` already uses, see
[a2a.md](./a2a.md)) and only that explicit call aborts it. A plain disconnect — the client's own
`fetch()` breaking, a proxy timing out, a closed tab — never cancels a run by itself; the run keeps
executing and persisting normally, and a reconnect via `GET /runs/:runId/stream` picks it back up
(see [transports.md](./transports.md)'s reconnect/replay contract). If the caller aborts before any
crumb has arrived, there's no `runId` yet to target — the remote run can't be told to stop in that
narrow window, an inherent limit of any id-addressed cancel.

**Known gap**: the cancel registry is scoped to one `mount()`/replica. In a load-balanced, multi-
replica deployment, a cancel routed to a different replica than the one running it 404s — see
[transports.md](./transports.md)'s Scaled deployment section and [a2a.md](./a2a.md)'s identical,
already-disclosed limitation for `tasks/cancel`.

## Limitations

- **No local HITL resume.** The remote owns its sessions and checkpoints, so a remote run that
  suspends at `human:required` must be resumed against the remote server, not via the local
  `bread.resume(...)`. Local resume stays local-only.
- **No local persistence — by deliberate design.** Dispatch to a remote agent skips local session
  creation entirely (`runAgent` returns immediately after relaying the remote's stream), and the
  remote's runId/sessionId don't exist in the local store. Rather than risk that hitting a
  foreign-key failure, the runner tags every relayed crumb (`runner.ts`'s `runAgent`, via the
  `RELAYED` symbol) and the crumb-log writer checks it explicitly before any store write:
  `if (!supported || run.disabled || run.relayed) return` (`crumb-log.ts:99`). The effect is the
  same as before — remote crumbs are relayed and observable but never durably persisted locally
  — but the mechanism is this explicit guard, not a swallowed FK error.
