<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/transport-redis

Redis Streams [`BreadTransport`](../../docs/transports.md) for [bread](https://github.com/matteozambon89/bread) —
the crumb fabric between replicas of one app. With it, `GET /runs/:runId/stream` and
cross-container HITL work from **any** container behind the load balancer: the replica executing
a run publishes every client-visible crumb as a `{ runId, seq, crumb }` frame; every other
replica can tail it live. The store stays the source of truth (catch-up/replay).

## Install

```bash
bun add @breadai/transport-redis ioredis
```

## Usage

```ts
// bread.config.ts — same config on every replica
import { transport } from '@breadai/transport-redis'

export default defineConfig({
  entrypoints: ['writer'],
  store: store(),                    // shared truth
  transport: transport(),            // shared liveness (REDIS_URL)
})
```

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `url` | `REDIS_URL` → `redis://localhost:6379` | Connection string |
| `keyPrefix` | `bread:run:` | Stream key prefix (`bread:run:{<runId>}` — braces are a cluster hash tag) |
| `maxLen` | `10000` | Approximate per-stream cap (`XADD MAXLEN ~`) |
| `ttlSeconds` | `86400` | Per-stream TTL, refreshed on every publish |
| `blockMs` | `1000` | `XREAD BLOCK` timeout — how fast new subscriptions go live |

## Semantics

- One Redis Stream per run; per-run ordering falls out of per-key ordering.
- Broadcast, not competing consumers: every replica sees every frame (plain `XREAD`, no
  consumer groups).
- At-least-once: per-key last-delivered ids survive ioredis auto-reconnects; duplicates are
  possible around a reconnect and clients dedup by `seq`.
- A late subscriber replays history via `subscribe(runId, afterSeq)`: each subscribe independently
  `XRANGE`s the run's retained history (bounded by `maxLen` + TTL, same trimming as above) and
  replays entries with `seq > afterSeq` before tailing live — the full `BreadTransport` contract
  guarantee, not just a tail-anchor.

Tests run against a real Redis: set `REDIS_URL`, or have `redis-server` on `PATH` (an ephemeral,
persistence-free instance is spawned), otherwise the contract registers as skipped.
