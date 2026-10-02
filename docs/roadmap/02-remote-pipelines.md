# Remote pipelines & remote branches — status and next steps

> Status note. Remote dispatch today is **agent-only**.

## Where we are

- `config.remoteAgents` + a transport's `remoteAgent()` dispatch `bread.run(agentId, …)` to another bread server (`POST /agents/:id/run`), relaying crumbs through the local choke point with local `seq` reassignment.
- `POST /pipelines/:id/run` exists as an HTTP ingress route, but there is **no remote pipeline step type** and no `remotePipeline()` helper. Same for branches (which don't exist yet as runtime).
- Relayed crumbs are observable but **not durably persisted locally** (explicit `RELAYED` guard in the crumb-log writer) — by design today.
- **HITL limitation**: a remote run that suspends must be resumed against the *remote* server. Local `bread.resume` is local-only. This is the main pain point for remote compositions.

## The proposal

Treat a remote pipeline as a **pipeline-as-a-node**: a thin `RemotePipeline` wrapper (same shape as `RemoteAgent` — anything with a `run(pipelineId, input, opts?)` yielding crumbs) that POSTs to the remote's `/pipelines/:id/run` and relays the NDJSON/SSE stream back through the local choke point.

- The outer pipeline sees the remote pipeline as one step: input in, output out, inner steps/branches/checkpoints stay internal.
- Inner HITL suspends the *inner* run; the outer pipeline sees a suspended step and waits. Resume must target the remote — the outer continuation cannot resume it locally.
- Streaming: the outer run sees the inner pipeline's crumbs relayed upward, same as remote agents today.

## What this solves

- **Distribution of work**: each node of a composition can live on a different server. The executor becomes a pure scheduler — pick next node, fire the call, wait, move on.
- Combined with the shared store + transport, this is the foundation for horizontal scaling: many executors, any replica can serve passive streams or resumes.

## What it does *not* solve

- Cross-node state shuttling beyond what the step contract already carries (input → output).
- The join problem for parallel remote branches (bounded by the slowest branch — already handled by `parallel`).
- Local HITL resume of remote suspensions (still remote-owned).

## Open questions

1. Should a remote pipeline's crumb log be persisted locally (today remote agent crumbs are not)? Trade-off: storage growth vs full local replay.
2. How does `POST /resume/:checkpointId` route when the checkpoint belongs to a remote pipeline — proxy through, or require the client to hit the remote directly?
3. Auth: does the remote pipeline wrapper reuse the `signer` from `remoteAgent()` options, or need its own?
