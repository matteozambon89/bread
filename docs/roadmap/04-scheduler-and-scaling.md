# Scheduler & scaling — status and next steps

> Status note. The foundation is built; the orchestration layer on top is not.

## What's built

- **Durability**: sessions, checkpoints, crumb log — restart-safe. HITL suspend persists checkpoint + messages atomically; resume replays from the store and works from a different container.
- **HITL in compositions**: pipeline checkpoint linkage (remaining steps self-contained), supervisor chain-suspend + cascade on child resume. Concurrent sibling resumes supported sequentially.
- **Transport seams**: HTTP ingress (`mount`), remote agents, cross-replica fan-out (Redis). Passive streams and resumes work from any replica sharing store + transport.
- **Public instance surface**: `run` / `resume` / `runPipeline` / `runTask` / `transport.subscribe` / `store.getCrumbs` — any custom ingress compiles against this alone.

## What's not built

1. **Remote pipeline / remote branch step types** (see `02-remote-pipelines.md`). Remote dispatch is agent-only.
2. **Run-tree streaming** (see `03-run-tree-streaming.md`). One stream per run today.
3. **A scheduler / work-queue execution model**. Execution is *pull-driven*: something must keep calling `next()` on the run's generator. The HTTP transports keep pulling even after client disconnect (so a dropped tab never stalls a run), but there is no "submit a run, any replica claims it" model. Explicitly **post-0.1** per `transports.md`.
4. **Cross-replica cancel**: `POST /runs/:runId/cancel` looks up the `AbortController` in a per-replica in-memory Map. A cancel landing on the wrong replica 404s. `BreadTransport` carries crumb frames only — no control channel.
5. **A transport that is both mount-capable and shared across replicas**: `@breadai/transport-redis` has no `mount`; the HTTP transports' pub/sub is in-memory. `config.transport` is one slot and no package fills both roles today.
6. **Crumb-log retention policy**: the log is unbounded; no pruning mechanism exists.

## The target shape (from the roadmap discussion)

With remote-everything + a scheduler:

- The **executor is stateless**: it holds the graph, picks the next node, fires the remote call, waits for the result, moves on. Continuations are written to the store at each step boundary and freed from memory — any replica can reload and resume.
- **Remote agents / pipelines solve *where* work runs**; the scheduler solves *how* it executes (ordering, joins, checkpointing).
- Horizontal scaling follows for free: N executors behind a load balancer, shared store as truth, shared transport as liveness.
- The graph layer (if built) compiles down to this same executor — one runtime, one HITL story, one crumb stream.

## Sequencing suggestion

1. Branch runtime (unblocks real composition usage).
2. Remote pipeline step type (unblocks distribution).
3. Run-tree streaming (unblocks the frontend story).
4. Work-queue / claim execution model (unblocks true horizontal scaling).
5. Cross-replica cancel channel (small, but needed for ops).
6. Graph layer as a compile-down on top of all of the above — only if Branch has real users and nesting gets painful.

## Design principles to preserve

- Config is source of truth; no silent defaults.
- The store is truth; the transport is liveness.
- A dropped connection never cancels a run — only an explicit cancel does.
- Crumb payloads must be JSON-serializable (live `BreadError` handled by wire form).
- Nothing below the choke point emits anywhere — plugin view ≡ transport view ≡ log ≡ client stream.
