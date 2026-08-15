# Tools

Tools are functions an agent can call. Drop a `defineTool` (or `defineHumanTool`) default export in
`agents/<id>/tools/*.ts` and the loader wires it in automatically.

```ts
// agents/researcher/tools/web-search.ts
import { defineTool } from '@bread/core'
import { z } from 'zod'

export default defineTool({
  name: 'web_search',
  description: 'Search the web and return the top results.',
  schema: z.object({ query: z.string(), limit: z.number().max(10).default(5) }),
  outputSchema: z.array(z.object({ title: z.string(), url: z.string() })),
  credentials: ['SEARCH_API_KEY'],
  async execute({ query, limit }, ctx) {
    const key = await ctx.credentials.get('SEARCH_API_KEY')
    const res = await fetch(`https://api.example.com/search?q=${query}&n=${limit}`, {
      headers: { authorization: `Bearer ${key}` },
    })
    return (await res.json()).results
  },
})
```

## Where an agent's tools come from

At run time the runner merges tools from several sources into one set:

- the agent's own `agents/<id>/tools/*.ts` (above),
- tools pulled in by a loaded [skill](./skills.md),
- **global plugin tools** — any `tools` a [plugin](./plugins.md) contributes are available to *every*
  agent without per-agent wiring, and
- **dynamic plugin tools** — a plugin's `resolveAgentTools` hook, driven by whatever that agent wrote
  under `cfg.plugins.<plugin-name>`. [MCP](./mcp-client.md) server tools an agent opts into work this
  way (`cfg.plugins.mcp_client`), and it's how any other plugin can offer the same per-agent,
  config-driven pattern — see [plugins.md](./plugins.md).

## `ToolContext`

`execute(args, ctx)` receives:

| Field | Description |
|-------|-------------|
| `agentId`, `runId`, `sessionId` | Identifiers for the current run. |
| `credentials` | A `CredentialProvider` — `await ctx.credentials.get(name)`. |
| `user?`, `tenantId?` | Caller context, when supplied. |
| `blobStore?` | A `BlobStore`, present when `config.blobStore` is set — `undefined` otherwise. Store a generated/derived file and echo the resulting `uri` as (part of) this tool's output; see [store.md](./store.md#blob-storage). |

Every call emits `tool:call` and `tool:result` crumbs, so tool usage is fully observable. If
`execute` throws and no `onError` hook (see [Hooks](#hooks)) recovers it, a `tool:error` crumb is
emitted instead before the error propagates.

`execute` may also return an `AsyncIterable<R>` instead of a single `Promise<R>`/`R` — yield
intermediate progress values as a long-running tool works, then **yield the final result as the
last value** (a `return`ed value, if any, is never observed — a plain `for await...of` drain, which
is how both bread and the AI SDK itself consume the iterable, only ever sees yielded values):

```ts
async *execute({ url }, ctx) {
  yield { status: 'started' }
  const res = await fetch(url)
  yield { status: 'downloaded', bytes: res.headers.get('content-length') }
  yield { status: 'done', body: await res.text() }
},
```

Each yielded value emits a `tool:result:partial` crumb (`{ toolCallId, toolName, result }` — no
`durationMs`, since it isn't final); the existing `tool:result` crumb still carries the final value
once the iterable is exhausted, unchanged. A streaming tool's `errorHandling.retry` has no effect —
retrying a partially-streamed operation isn't supported (see [Hooks](#hooks)).

## Hooks

A tool can declare `hooks?: Partial<ToolHooks<Args, Result>>` and `errorHandling?: { retry }`,
the same `beforeRun`/`afterRun`/`onError` shape documented in
[agents.md#hooks](./agents.md#hooks) — `beforeRun` may override the args passed to `execute` or
short-circuit the call entirely (e.g. a cache), `afterRun` may replace the result, `onError` may
recover with a substitute result, request a retry, or force failure with a replacement error.
Bound to the tool's own `errorHandling.retry`, same field shape as `AgentConfig`/`TaskConfig`.

```ts
export default defineTool({
  name: 'web_search',
  // …
  hooks: {
    onError: () => ({ action: 'recover', output: [] }), // empty results beat a failed run
  },
  errorHandling: { retry: { attempts: 2 } },
  async execute({ query, limit }, ctx) { /* … */ },
})
```

The exact same `def.execute` call — whether reached during a live model-driven tool call or after
a human approves an ask-gated tool on resume ([hitl.md](./hitl.md)) — goes through this one hook
path (`beforeRun`/`afterRun`/`tool:call`/`tool:result`/`tool:error` are identical either way). The
one exception is `onError`/retry for a streaming (`AsyncIterable`-returning) `execute`: a thrown
error there always surfaces as `tool:error` and rethrows immediately, with no retry attempt, in
both the live and resume paths. Like every other scope, a tool's own hook runs first, then any
plugin-contributed hooks, then `BreadConfig.hooks` — see
[agents.md#chain-order](./agents.md#chain-order).

## Credential providers

bread ships two `CredentialProvider`s:

```ts
import { envProvider, vaultProvider } from '@bread/core'

envProvider()                                   // reads process.env[name]
vaultProvider({ address, token })               // reads from HashiCorp Vault
```

`vaultProvider` treats both the credential name and the mount as literal path segments in Vault's
HTTP API (`/v1/{mount}/data/{name}`), so both are validated against `/^[A-Za-z][A-Za-z0-9_-]*$/`
(letters, digits, `_`, `-`, starting with a letter) before ever reaching `fetch`. A name or mount
outside that charset — e.g. containing `/`, `.`, `?`, `#`, or whitespace — throws a `BreadError`
(`INVALID_CREDENTIAL_NAME` for the name, `INVALID_VAULT_MOUNT` for the mount) instead of being
sent as part of the request path. The mount is checked once, when `vaultProvider(opts)` is
constructed; the name is checked on every `.get(name)` call. This means the built-in
`vaultProvider` cannot address Vault's nested K/V paths (e.g. `"app/db-password"`) — write a
custom `CredentialProvider` if you need that.

Declare the names a tool needs in `credentials: [...]`; resolve them at call time via
`ctx.credentials.get()`. Never hard-code secrets in tool code.

The array is an enforced allowlist, not just documentation: `ctx.credentials.get(name)` throws a
`BreadError` (`code: 'CREDENTIAL_NOT_DECLARED'`) if `name` isn't in the tool's own `credentials`
array — this applies even to names the underlying provider would otherwise resolve. A tool with no
`credentials` array (or an empty one) gets no credentials at all; every name must be declared
explicitly.

Wire a provider in at two levels — a run-wide default on `BreadConfig`, and/or a per-tool override
that takes priority over the default:

```ts
// bread.config.ts — a run-wide default every tool falls back to
export default defineConfig({
  entrypoints: [...],
  credentials: envProvider(), // or vaultProvider({ address, token })
})
```

```ts
// a single tool overriding the default, e.g. to scope it to Vault
export default defineTool({
  name: 'web_search',
  description: 'Search the web and return the top results.',
  schema: z.object({ query: z.string() }),
  credentials: ['SEARCH_API_KEY'],
  credentialProvider: vaultProvider({ address, token, mount: 'secret' }),
  async execute({ query }, ctx) {
    const key = await ctx.credentials.get('SEARCH_API_KEY')
    // ...
  },
})
```

If neither the tool nor `BreadConfig` sets a provider, `ctx.credentials.get()` falls back to
`process.env`.

## Human tools (HITL)

`defineHumanTool(name, schema)` creates a tool that pauses the run and asks a human. See
[hitl.md](./hitl.md).

```ts
// agents/publisher/tools/approve.ts
import { defineHumanTool } from '@bread/core'
import { z } from 'zod'

export default defineHumanTool('approve_publish', z.object({ url: z.string() }))
```
