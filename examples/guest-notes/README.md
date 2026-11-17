# guest-notes

A host remembers a guest. The session stays in SQLite. The notes are `:BreadMemory` nodes in Neo4j. Recall is a case-insensitive contains match on that content. There is no embedding.

The memory page is [memory](../../docs/memory.md). The agent is [`agents/host`](./agents/host/agent.ts).

`NEO4J_URL` selects the Bolt endpoint. `NEO4J_USERNAME` and `NEO4J_PASSWORD` are passed only when both are set.

`forget` and `dream` ask before they change notes.

```bash
bun install
bread dev
```
