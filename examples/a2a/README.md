# a2a

Two bread apps, same `assistant` agent, exposed under each live A2A spec generation via
`@breadai/protocol-a2a-server`'s `a2aServer()`: **v03** speaks v0.3.x (`message/send`, the
interoperable default), **v1** speaks v1.0 (`SendMessage`, PascalCase/gRPC-style). See
[docs/a2a.md](../../docs/a2a.md) for the full protocol writeup.

```bash
bun install

# terminal 1 — v0.3.x (port 3000)
bun run dev:v03

# terminal 2 — v1.0 (port 3001)
bun run dev:v1
```

**v0.3 — discover the Agent Card, then invoke via `message/send`:**

```bash
curl localhost:3000/.well-known/agent-card.json

curl -X POST localhost:3000/a2a \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"hi"}],"messageId":"m1","kind":"message"}}}'
```

**v1.0 — same idea, `SendMessage`, no `kind` discriminator:**

```bash
curl localhost:3001/.well-known/agent-card.json

curl -X POST localhost:3001/a2a \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"ROLE_USER","parts":[{"text":"hi"}],"messageId":"m1"}}}'
```

The two Cards' shapes differ — v0.3's is flat (`url`, `protocolVersion: "0.3.0"`), v1.0's wraps its
endpoint in `supportedInterfaces: [{url, protocolBinding, protocolVersion}]`. Both mounts can also
run in the *same* process (see `docs/a2a.md`'s "Choosing a spec version" section) as long as each
gets its own `cardPath` — required, not defaulted, so a second mount's Card can never silently
shadow the first's.
