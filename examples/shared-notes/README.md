# shared-notes

Notes live in SQLite. Each id is mirrored to a `:BreadMemory` node. Recall reads the store and does not call the graph. `matching_notes` reads the copy for this run’s agent, the local CLI issuer, and the run subject.

The memory page is [memory](../../docs/memory.md). The agent is [`agents/scribe`](./agents/scribe/agent.ts).

`NEO4J_URL` selects the Bolt endpoint. `NEO4J_USERNAME` and `NEO4J_PASSWORD` are passed only when both are set.

Delete one `:BreadMemory` node in Neo4j. Recall still returns the store row. The next dream creates that id again. `forget` and `dream` ask before they change notes.

```bash
bun install
bread dev
```
