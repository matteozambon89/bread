# Auth — `@breadai/auth-api-key`, `@breadai/auth-jwt`, `@breadai/auth-oauth2`

Auth for bread splits into two roles, each its own core type:

- **server side** — a `BreadAuthStrategy`'s `authenticate(req)` validates an incoming request → an
  `AuthIdentity` or `null`.
- **client side** — a `BreadSigner`'s `sign(headers)` attaches credentials to an outgoing request.

Three packages, one per mechanism, each exporting the half(s) it supports. To attach a strategy to
a running server, pass it to `@breadai/server`'s `authPlugin()` — see
[Guarding the server](#guarding-the-server) below.

| Package | `authStrategy(opts)` | `signer(opts)` |
|---|---|---|
| `@breadai/auth-api-key` | yes | yes |
| `@breadai/auth-jwt` | yes | — (verification only) |
| `@breadai/auth-oauth2` | yes (`VerifyOptions`) | yes (`ClientCredentialsOptions`, distinct shape) |

```bash
bun add @breadai/auth-api-key   # or auth-jwt / auth-oauth2
```

## API key

```ts
import { authStrategy, signer } from '@breadai/auth-api-key'

const strategy = authStrategy({
  header: 'authorization',     // default
  scheme: 'Bearer',            // omit for a raw x-api-key header
  keys: [process.env.API_KEY!],
  // or resolve from a credential provider:
  // credentials: envProvider(), credentialName: 'API_KEY',
})
```

Server side compares the presented key **timing-safely**; `signer(opts)` (same options shape)
attaches the first key.

## JWT

```ts
import { authStrategy } from '@breadai/auth-jwt'

const strategy = authStrategy({
  secret: process.env.JWT_SECRET,        // HS256, or:
  jwksUri: 'https://issuer/.well-known/jwks.json',  // RS/ES via remote JWKS
  issuer: 'urn:my:issuer',
  audience: 'urn:my:api',
  // algorithms: ['HS256'],              // optional — see the default below
})
```

Verification uses [`jose`](https://github.com/panva/jose). The resolved identity carries the full
claims: `{ subject: String(payload.sub ?? 'jwt'), claims: payload }` — `subject` falls back to the
literal string `'jwt'` when the token has no `sub` claim. `@breadai/auth-jwt` is verification-only —
no `signer`; a static preconfigured token to attach was its weakest capability and isn't carried
over.

`authStrategy()` validates its config **at construction**, not on first use — a misconfigured
strategy fails fast rather than on the first real request:
- Throws unless `secret` or `jwksUri` is set.
- Throws unless `issuer` and/or `audience` is set, or `allowUnverifiedIssuerAudience: true` is
  passed to explicitly accept signature+expiry-only verification.

`algorithms` restricts the accepted `alg` values (passed straight to `jwtVerify`). Defaults to
`['HS256']` in `secret` mode, or the common RS/PS/ES set in `jwksUri` mode — pin a narrower list if
your key material only ever uses one algorithm.

## OAuth 2.0

The MCP standard for HTTP transports. Two independent factories, each with its own option shape —
not one call conditionally shaped by which fields you pass.

```ts
import { authStrategy, signer } from '@breadai/auth-oauth2'

// server side: validate incoming bearer tokens as JWTs (reuses @breadai/auth-jwt internally)
const strategy = authStrategy({
  jwksUri: 'https://issuer/.well-known/jwks.json',
  issuer: 'https://issuer/',
})

// client side: client-credentials grant, with token caching
const sign = signer({
  tokenUrl: 'https://issuer/oauth/token',
  clientId: process.env.CLIENT_ID!,
  clientSecret: process.env.CLIENT_SECRET!,
  scope: 'agents:run',
})
```

`ClientCredentialsOptions` requires `tokenUrl`/`clientId`/`clientSecret` at the type level — an
incomplete client config is a compile error, not a construction-time throw. `VerifyOptions` mirrors
`@breadai/auth-jwt`'s `JwtOptions` field-for-field (including `algorithms` and
`allowUnverifiedIssuerAudience`), and `authStrategy()` inherits the same construction-time
validation described above, since it delegates straight to `@breadai/auth-jwt`.

`clientSecret` is an ordinary string option: it lives in whatever loaded your config (typically
an env var, as above) and is sent form-encoded to `tokenUrl` over whatever transport that URL
uses — always make it HTTPS. To source it from a secret store instead of `process.env`, resolve
it before calling `signer(...)` (e.g. via a core `CredentialProvider` like `vaultProvider`).

## Guarding the server

Bread has no built-in opinion on auth — a server with no auth plugin serves every request, no
gate. Configuring auth (or any other posture: a reverse proxy, a network boundary, your own
middleware) is entirely up to you. `@breadai/server`'s `authPlugin()` turns one or more strategies
into a `BreadPlugin` you drop into `config.plugins`, same as any other plugin: it rejects any
request none of the strategies authenticate (`401`), and stashes the identity on the request
context.

There is one warning, not a gate: `bread dev`/`bread start` print a loud `console.warn` when the
resolved host isn't loopback (`localhost`/`127.0.0.1`/`::1`) and zero plugins in `config.plugins`
register `middleware` at all. It cannot tell whether any registered middleware actually *is* an
auth check — only that at least one plugin hooked in — so it's a floor, not a guarantee: possible
to silence with any middleware-registering plugin, real or not, and it never blocks startup either
way. Binding loopback, or registering `authPlugin(...)` (or any other `BreadPlugin.middleware`),
silences it.

```ts
// bread.config.ts
import { defineConfig } from '@breadai/core'
import { authStrategy } from '@breadai/auth-api-key'
import { authPlugin } from '@breadai/server'

export default defineConfig({
  entrypoints: ['researcher'],
  plugins: [authPlugin([authStrategy({ keys: [process.env.API_KEY!] })])],
})
```

A direct `createServer()` consumer (no `bread.config.ts`) wires this the same way, since plugins
are just part of `config.plugins`. `authMiddleware(strategies)` (also exported from
`@breadai/server`) is the lower-level building block `authPlugin()` is built on, if you'd rather
apply it to a Hono app yourself instead of going through the plugin system.

## Signing outgoing requests

Pass a `BreadSigner` to anything that makes outbound calls — e.g. an MCP client server entry (see
[mcp-client.md](./mcp-client.md)) or a remote agent (see [remote-agents.md](./remote-agents.md)) —
and it attaches credentials via `sign()`:

```ts
const headers = new Headers()
await sign.sign(headers)   // → Authorization: Bearer <token>
```
