# @breadai/graph-neo4j

A `Graph` for [bread](https://matteozambon89.github.io/bread/). Named catalog queries are documented on the [graph](https://matteozambon89.github.io/bread/graph.html) page. This package implements `run`. It is not a `BreadStore`. Sessions stay on the store you configure.

```bash
bun add @breadai/graph-neo4j
```

```ts
import { graph } from '@breadai/graph-neo4j'

const username = process.env.NEO4J_USERNAME
const password = process.env.NEO4J_PASSWORD

graph({
  url: process.env.NEO4J_URL ?? 'bolt://127.0.0.1:7687',
  ...(username && password ? { auth: { username, password } } : {}),
})
```

`NEO4J_USERNAME` and `NEO4J_PASSWORD` are read by your app. This package does not read a password from the URL. A URL with a username, password, query, or hash is rejected.

Loopback (`localhost`, `127.0.0.1`, `::1`) may use `bolt` or `neo4j`. Any other host must use `bolt+s`, `neo4j+s`, `bolt+ssc`, or `neo4j+ssc`. `+s` checks the server certificate. `+ssc` encrypts and accepts a self-signed certificate. It does not verify the peer the way `+s` does.

Each call opens one session and closes it when the call finishes. Read mode uses a read transaction. Write mode uses a write transaction. The default caps are 100 rows, 1048576 bytes, and 10000 ms. A safe integer parameter, including one nested in an array or object, is sent as a Neo4j integer. Any other number stays a float. Neo4j rejects a float `LIMIT` or `SKIP`.

Source: [graphs/neo4j](https://github.com/matteozambon89/bread/tree/HEAD/graphs/neo4j). The station walk is [examples/kitchen](https://github.com/matteozambon89/bread/tree/HEAD/examples/kitchen).
