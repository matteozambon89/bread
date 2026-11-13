# kitchen

Sessions stay on SQLite. The station walk is a Neo4j graph: the walker calls named catalog tools and never sends Cypher.

The graph page is [graph](../../docs/graph.md). The agent is [`agents/walker`](./agents/walker/agent.ts).

`NEO4J_URL` selects the Bolt endpoint. `NEO4J_USERNAME` and `NEO4J_PASSWORD` are passed only when both are set.

`mark_visited` sets `requireTenant: false` so the local CLI, which has no tenant, can record a visit. Authenticated users with no tenant share that same null-tenant scope. The example does not put `mark_visited` on `permissions.allow`, so the write still asks.

```bash
bun install
bread dev
```
