# Run-tree streaming — status and next steps

> Status note. Design only; the choke point and framing crumbs exist, the tree interface does not.

## Where we are

- One per-run **choke point**: every crumb gets a `seq`, is appended to the durable crumb log, delivered to local listeners, published to the transport. Remote relays pass through the same point (with local `seq` reassignment).
- `GET /runs/:runId/stream` replays the durable log from seq 0 (or `Last-Event-ID`) then tails live frames. Works from any replica sharing store + transport. Closes after a terminal crumb.
- Pipelines already emit `pipeline:step:start` / `pipeline:step:end` framing crumbs. Supervisors emit `subagent:run:start` / `subagent:run:end`.
- **Gap**: each run has its own stream. A graph/pipeline with N nodes = N subscriptions the frontend must stitch. No run tree, no aggregated stream, no `path` field on crumbs.

## The proposal

`GET /runs/:runId/tree/stream` — one NDJSON/SSE stream for the whole composition:

- Every frame carries a `path`: the node sequence from the root (e.g. `[0, 1]` for step 0's first nested step).
- Path stamping happens at the choke point as crumbs relay upward, so the frontend sees one ordered stream and can render a tree or flatten it.
- The parent run's log becomes the canonical record of everything underneath it.

## Why it scales (not a hack)

- **Store is truth**: the durable crumb log is unbounded; transport retention is bounded and implementation-defined. A closed tab reopens with full replay from the store — no data loss.
- **Transport is liveness**: live fan-out only; if it's down, runs still execute and persist.
- Pruning checkpoints does **not** touch the crumb log (`bread_checkpoints` vs `bread_crumbs` are separate tables). Crumb rows cascade with their session — deleting a session deletes its crumbs — but there is no crumb-pruning mechanism today; the log just grows. Long-running graphs with heavy `text:delta` traffic will need a retention policy eventually.
- Degradation is explicit: a store without crumb-log methods serves live-tail-only (no replay) and logs a startup notice.

## Coverage

- **Pipelines**: easiest case — nest existing `pipeline:step:*` framing under the parent path.
- **Parallel**: each branch gets its own path segment; the merge step's output lands as the parent's continuation.
- **Remote agents / remote pipelines**: relayed crumbs already pass the local choke point; the path gets stamped on the way up. Identity is the `path`, not `seq` (relayed seqs are reassigned).
- **Supervisors**: `subagent:run:*` framing maps to path segments naturally.
- **Loops**: `loop:*` crumbs map to iteration path segments.

## Open questions

1. Path representation: array of indices, dotted string, or crumb-type-aware?
2. Should the tree stream include *all* crumbs or only framing + durable ones (excluding raw `text:delta` to save bandwidth)?
3. Authorization: reuse `authorizeStream(identity, runId)` or add a tree-level variant?
4. Does the tree stream close when the *root* terminates, or when every nested run terminates?
