# remote-agent

Two bread apps: a **provider** serving a `researcher` agent behind an API-key gate, and a
**consumer** that dispatches to it via `@bread/transport-http-chunked`'s `remoteAgent()` —
registered under `remoteAgents`, signed per request with the shared key.

```bash
bun install

# terminal 1 — the provider (port 4001, requires Authorization: Bearer dev-key)
bun run dev:provider

# terminal 2 — the consumer (port 4002)
bun run dev:consumer

# Run the REMOTE agent through the consumer: the consumer's remoteAgent() signs
# the hop to the provider; the provider runs the model and streams crumbs back
# as NDJSON (one Bread protocol CrumbFrame per line).
curl -N -X POST localhost:4002/agents/researcher/run \
     -H 'content-type: application/json' -d '{"input":"What is sourdough?"}'

# Hitting the provider directly without the key is rejected:
curl -X POST localhost:4001/agents/researcher/run -d '{"input":"hi"}'   # → 401
```

`researcher` is not in the consumer's local registry — `remoteAgents` shadows it. Signing runs
on **every** outgoing request (`signer` accepts any `BreadSigner`, incl. `@bread/auth-oauth2`'s
`signer(...)` whose cached token then refreshes naturally). Set `RESEARCH_TOKEN` to change the
shared key, `RESEARCH_URL` to point the consumer elsewhere. See
[docs/remote-agents.md](../../docs/remote-agents.md).
