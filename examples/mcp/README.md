# mcp

Two bread apps: a **server** exposing an `echo` agent as an MCP tool over Streamable HTTP
(`@breadai/protocol-mcp-server`), and a **client** whose `assistant` agent consumes it as an
ordinary tool (`@breadai/protocol-mcp-client`) — `bridge__echo`.

```bash
bun install

# terminal 1 — the MCP server (port 4101, exposes /mcp and /agents/echo/run)
bun run dev:server

# terminal 2 — the MCP client (port 4102)
bun run dev:client

# Ask the client's assistant to echo something — its model calls bridge__echo,
# which round-trips to the server over MCP:
curl -N -X POST localhost:4102/agents/assistant/run \
     -H 'content-type: application/json' -d '{"input":"please echo: sourdough"}'

# echo also works as an ordinary local agent on the server, not just via MCP:
curl -N -X POST localhost:4101/agents/echo/run \
     -H 'content-type: application/json' -d '{"input":"hi"}'
```

`bridge` is not a local agent on the client — `mcpClient` connects to the server's `/mcp`
endpoint on startup, lists its tools, and translates them into ordinary bread tools named
`<server>__<tool>`. Set `MCP_URL` to point the client at a server running elsewhere.

Both sides run on the v2 MCP SDK (`@modelcontextprotocol/server`/`client`), which serves and
speaks the 2025-11-25 and 2026-07-28 protocol revisions from the same endpoint/connection —
nothing above wires up era negotiation or DNS-rebinding protection explicitly; both are real,
documented config knobs (`allowedHosts`, `versionNegotiation`) covered in
[docs/mcp-server.md](../../docs/mcp-server.md) and [docs/mcp-client.md](../../docs/mcp-client.md).
