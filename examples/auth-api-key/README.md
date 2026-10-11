# auth-api-key

Guards every route with an API key via `@breadai/auth-api-key`'s `authStrategy()`, wired in with
`@breadai/server`'s `authPlugin()` — the request is rejected (`401`) unless it presents the key. `server.authorize` allows every
action for that identity. A real app branches on action and args.

```bash
bun install && BREAD_API_KEY=s3cret bread dev

curl -X POST localhost:3000/agents/greeter/run -d '{"input":"hi"}'          # → 401
curl -H 'Authorization: Bearer s3cret' \
     -X POST localhost:3000/agents/greeter/run -d '{"input":"hi"}'          # → NDJSON stream
```
