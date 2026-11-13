# Graph

`config.graph` is a `Graph`. Core does not import a driver. [`@breadai/graph-neo4j`](https://github.com/matteozambon89/bread/tree/HEAD/graphs/neo4j) implements `run`. This is not a `BreadStore` and not a `BreadPlugin`. Sessions stay on `config.store` — see [store.md](./store.md).

Named queries live in `config.graphCatalog`. An agent opts in with `graph: ['stations', 'next_station']`. Each name becomes the tool `core_<name>` (selector `core:<name>`). The model sends the catalog schema only. It never sends Cypher. The statement is the static catalog string.

[`examples/kitchen`](https://github.com/matteozambon89/bread/tree/HEAD/examples/kitchen) keeps sessions on SQLite and uses the graph for a station walk.

## Binds

Every call binds `agentId`, `sessionId`, `tenant`, and `subject` from the run (`ToolContext`, and on resume the checkpoint principal). Those names, and `statement`, are reserved. A catalog schema or a parsed argument that includes one throws `GRAPH_PARAM_RESERVED`. Forged values in the model arguments do not win.

`tenant` is `principal.tenant`, or JSON `null` when the principal has none. Null is one scope, not every tenant. It is not omitted and it is not `*`. A query that should stay inside one tenant uses this predicate, in parentheses, on every bound node, including the target of a hop:

```cypher
(node.tenant IS NULL AND $tenant IS NULL) OR node.tenant = $tenant
```

Do not filter with `$tenant IS NULL OR node.tenant = $tenant`. A null parameter would match every tenant. Set `tenant` from `$tenant` on every node you create. Setting it to null removes the property, which is the null scope.

`requireTenant` defaults to on for writes. A null tenant then throws `GRAPH_TENANT_REQUIRED` and `run` is not called. The local CLI principal has no tenant, so a default write fails closed. `requireTenant: false` is only for that local CLI. Tenant-less authenticated users (a JWT with no tenant claim, for example) share the null scope with the CLI and with each other. Reads do not require a tenant. Core does not inject the predicate for you.

## Ask

Write tools set `ask: true`. The run suspends until `resume(checkpointId, { approved: true })`. `run` is not called before that approval. An exact `permissions.allow` entry such as `core:mark_visited` skips the ask. A glob such as `core:*` does not. `permissions.ask` plus that exact allow stays gated.

## Parameters

Catalog Cypher is a static string. A parameter must not be a statement or a URL the server will fetch. If the statement, with comments removed, contains `LOAD CSV`, `apoc.cypher`, `apoc.load`, or `apoc.import`, and the schema has any parameter, the call throws `GRAPH_PARAM_REJECTED` and does not run. Nested parameters count. A static `LOAD CSV` with an empty object schema is the author's string. A normal URL parameter on a statement that does not fetch is allowed.

## Driver

`graph({ url, auth? })` checks the URL before it constructs a driver. A username, password, query string, or hash is rejected, including on loopback. A URL that does not parse is the same error. The message is fixed and carries no context. The driver never reads a password from the URL. Pass `auth` only from your own env vars. The checked URL is what the driver sees; changing `options.url` later does not.

Loopback is only `localhost`, `127.0.0.1`, and `::1`. It may use `bolt`, `neo4j`, `bolt+s`, `neo4j+s`, `bolt+ssc`, or `neo4j+ssc`. `bolt://127.0.0.1:7687` is the cleartext loopback form. Any other host must use `bolt+s`, `neo4j+s`, `bolt+ssc`, or `neo4j+ssc`. `+s` checks the server certificate. `+ssc` encrypts the connection and accepts a self-signed certificate. It does not verify the peer the way `+s` does.

Each call opens one session and closes it in `finally`. Read mode uses a read transaction. Write mode uses a write transaction. Defaults are 100 rows, 1048576 bytes, and 10000 ms. Passing either cap returns the fitting rows and `truncated: true`. A row that does not fit is not returned. A safe integer parameter, including one nested in an array or object, is sent as a Neo4j integer. Any other number stays a float. Neo4j rejects a float `LIMIT` or `SKIP`. A driver failure becomes `GRAPH_QUERY_FAILED`. The message is fixed. At the tool, the context is `{ query: name }` only. The driver message, the statement, and the URL are not included.

`close` on `bread.stop()` closes the driver if a call opened one.

## Errors

| Code | Message |
|------|---------|
| `GRAPH_NOT_CONFIGURED` | Graph is not configured. |
| `GRAPH_QUERY_NOT_FOUND` | Graph query not found. |
| `GRAPH_QUERY_INVALID` | Graph query schema must be an object. |
| `GRAPH_PARAM_RESERVED` | Graph parameter is reserved. |
| `GRAPH_PARAM_REJECTED` | Graph parameter is not allowed. |
| `GRAPH_TENANT_REQUIRED` | Graph query requires a tenant. |
| `GRAPH_QUERY_FAILED` | Graph query failed. |
| `GRAPH_URL_REJECTED` | Graph URL is not allowed. |
