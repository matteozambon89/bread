# Glossary — the bread lexicon

The named concepts in this codebase, in one place. If a bread-themed term is not on this page,
it is not part of the project's vocabulary.

## Crumb (`BreadCrumb`)

The typed stream atom — every event a run emits (`text:delta`, `tool:call`, `agent:run:end`,
`loop:*`, `human:required`, …) is one crumb dropped along the path of execution, and the run
stream (NDJSON or SSE, depending on `config.transport`) is the breadcrumb trail a client follows to
reconstruct what happened. Crumbs anchor the entire event model. See
[architecture.md](./architecture.md) and [http-api.md](./http-api.md).

## Transport (`BreadTransport`), Frame (`BusFrame`), and `seq`

The **transport** is the crumb fabric between replicas of one app (`config.transport`): the
replica executing a run publishes each client-visible crumb as a **frame** — `{ runId, seq, crumb }`
— and any replica can subscribe to a run's live tail, with a bounded seq-based (`afterSeq`) replay
guarantee for duplex transports. `seq` is the crumb's per-run monotonic position in the durable
**crumb log** (`text:delta`s carry the last durable seq as a watermark), which is what
`Last-Event-ID` catch-up replays. The store is the durable, unbounded source of truth; a
transport's own replay is a bounded convenience on top. Default is the embedded Stream transport;
`@breadai/transport-redis` is the distributed implementation. See [transports.md](./transports.md).

## Plugin (`BreadPlugin`) — formerly *Spread*

Anything applied onto the core framework: pre-built agents, tools, auth strategies, HTTP routes,
lifecycle hooks. (Model providers are a config-level seam, not a plugin one — see
[agents.md#providers](./agents.md#providers).) Early versions called this a *Spread* (butter on
bread); the alias was renamed
to `BreadPlugin` for immediate legibility and the deprecated `Spread`/`SpreadContext` aliases
have since been **removed** from the public API. See [plugins.md](./plugins.md).

## Loaf, Slice, and other bread words

Not concepts. The project name and its logo lean on the bread metaphor, but no type or API is
named `Loaf`, `Slice`, `Knead`, etc. If you half-remember such a term, this page is the
authoritative "no".

## The non-metaphor names

The rest of the vocabulary is deliberately literal: **agent**, **tool**, **task** (one-shot,
stateless), **skill** (loadable instruction pack), **loop** (agent-driven iteration),
**pipeline** (declared step sequence), **supervisor** (LLM-driven delegation to sub-agents via
`core_delegate`), **store**
(`BreadStore` persistence), **session**, **checkpoint** (HITL suspension point), **HITL**
(human-in-the-loop), **remote agent** (`RemoteAgent`, `remoteAgent()` — the peer-transport seam to
another bread instance), and **frame** (`BusFrame`/`CrumbFrame` — the local/wire envelope for a
crumb). Each has a doc page under [docs/](./).
