# Auth — `@breadai/auth-api-key`, `@breadai/auth-jwt`, `@breadai/auth-oauth2`, `@breadai/auth-trusted`

Auth for bread splits into two roles, each its own core type:

- **server side** — a `BreadAuthStrategy`'s `authenticate(req)` validates an incoming request → an
  `AuthIdentity` or `null`.
- **client side** — a `BreadSigner`'s `sign(headers)` attaches credentials to an outgoing request.

Four packages, one per mechanism, each exporting the half(s) it supports. To attach a strategy to
a running server, pass it to `@breadai/server`'s `authPlugin()` — see
[Guarding the server](#guarding-the-server) below.

| Package | `authStrategy(opts)` | `signer(opts)` |
|---|---|---|
| `@breadai/auth-api-key` | yes | yes |
| `@breadai/auth-jwt` | yes | — (verification only) |
| `@breadai/auth-oauth2` | yes (`VerifyOptions`) | yes (`ClientCredentialsOptions`, distinct shape) |
| `@breadai/auth-trusted` | yes | — (verification only) |

```bash
bun add @breadai/auth-api-key   # or auth-jwt / auth-oauth2 / auth-trusted
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

A matching key is `{ subject: 'api-key' }` with no claims. Every key of one strategy shares
that subject. Bread does not invent a role from this identity.

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
claims: `{ subject: String(payload.sub ?? 'jwt'), claims: payload }`. `subject` falls back to the
literal string `'jwt'` when the token has no `sub` claim, and that identity has no `principal`.
When `iss` and `sub` are both non-empty strings, it also sets `principal` to `{ iss, sub }` with
no `tenant`. `@breadai/auth-oauth2` verifies through this strategy, so it sets the same principal.
`@breadai/auth-jwt` is verification-only — no `signer`; a static preconfigured token to attach
was its weakest capability and isn't carried over.

`authStrategy()` validates its config **at construction**, not on first use — a misconfigured
strategy fails fast rather than on the first real request:
- Throws unless `secret` or `jwksUri` is set.
- Throws unless `issuer` and/or `audience` is set, or `allowUnverifiedIssuerAudience: true` is
  passed to explicitly accept signature+expiry-only verification.

`algorithms` restricts the accepted `alg` values (passed straight to `jwtVerify`). Defaults to
`['HS256']` in `secret` mode, or the common RS/PS/ES set in `jwksUri` mode — pin a narrower list if
your key material only ever uses one algorithm.

## OIDC

`oidcStrategy` verifies tokens from one or more OpenID Connect issuers. Each entry is one
provider. Discovery supplies the JWKS. Algorithms are asymmetric only (`RS256`, `RS384`,
`RS512`, `ES256`, `ES384`, `ES512`, `EdDSA`). There is no shared secret and no `PS*` algorithm.
`authStrategy` is unchanged, including HS256 and the RS/PS/ES JWKS default. Verification only —
no `signer`. The strategy name is `oidc`.

```ts
import { oidcStrategy } from '@breadai/auth-jwt'

const strategy = oidcStrategy({
  issuers: [
    {
      issuer: 'https://login.microsoftonline.com/{tenant}/v2.0',
      audience: 'api://bread',
      preset: 'entra',
    },
    {
      issuer: 'https://cognito-idp.{region}.amazonaws.com/{poolId}',
      audience: 'client-id',
      preset: 'cognito',
    },
    {
      issuer: 'https://accounts.google.com',
      audience: 'client-id',
      preset: 'google',
    },
    {
      issuer: 'https://my.auth0.com/',
      audience: 'client-id',
      preset: 'auth0',
    },
    {
      issuer: 'https://my.okta.com/oauth2/default',
      audience: 'api://bread',
      preset: 'okta',
      tenantClaim: 'tenant',
    },
    {
      issuer: 'https://keycloak.example/realms/myrealm',
      audience: 'bread',
      preset: 'keycloak',
    },
  ],
  header: 'authorization', // optional
  algorithms: ['RS256'], // optional
})
```

`authenticate` reads that one header. A missing or empty header returns null. It does not read
any other header. An unverified `iss` only selects a configured entry. An unknown or non-string
`iss` returns null and does not fetch discovery.

Discovery is `{issuer}/.well-known/openid-configuration`, with one trailing slash removed first,
so an issuer that already contains a path still resolves. The document and its JWKS are cached
for the life of the strategy. A failed discovery is not cached. Discovery does not follow
redirects. The document's `issuer` must equal the configured issuer. `jwks_uri` must be `https`,
or `http` on `localhost` or `127.0.0.1`. A different host is allowed — Google publishes keys on
`www.googleapis.com` while `issuer` is `https://accounts.google.com`. Any other `jwks_uri` returns
null.

`jose` verifies the token against that JWKS and picks the key by `kid`, pinned to the entry's
issuer, audience, and the algorithm allowlist. The `google` preset accepts both `iss` values when
the configured issuer is exactly `https://accounts.google.com`: that URL and `accounts.google.com`.
`principal.iss` stays the verified token `iss`. Any other issuer must match exactly. `sub` must be
a non-empty string. There is no `jwt` subject fallback. A failed discovery or a failed verify
returns null. It does not throw on the request path.

On success the identity is `{ subject: sub, claims: payload, principal: { iss, sub, tenant? } }`.
`tenant` is set only when the chosen claim is a non-empty string. Roles stay on `claims`.
`Principal` has no `roles` field.

| Preset | Tenant claim | When it is copied |
|---|---|---|
| `entra` | `tid` | Microsoft tenant id on the ID token. |
| `cognito` | `custom:tenant` | Only when the pool defines that attribute. |
| `google` | `hd` | Workspace or Cloud organization domain. Personal accounts omit it. |
| `auth0` | `org_id` | When the user signs in through an Organization. |
| `okta` | none | No preset claim. Set `tenantClaim` to require one. |
| `keycloak` | none | The realm is already in `iss`. Set `tenantClaim` to require one. |

A preset claim that is missing, empty, or not a string leaves `tenant` unset and still
authenticates. `tenantClaim` overrides the preset and is required: missing, empty, or not a
string returns null.

Construction throws, with no network call, when `issuers` is empty, two entries share an
`issuer` string, an `issuer` or `audience` is empty, an `issuer` is not `https` and not
`http://localhost` or `http://127.0.0.1`, or `algorithms` includes anything outside the set
above.

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

## Trusted identity

A gateway that already authenticated the caller can hand bread one signed JWT.
`@breadai/auth-trusted` verifies that token against one JWKS and one issuer, then sets
`principal`. Asymmetric algorithms only (`RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`,
`ES256`, `ES384`, `ES512`, `EdDSA`). There is no shared secret and no `allowUnverifiedIssuerAudience`.
Verification only — no `signer`. Unsigned identity headers are ignored. mTLS is not this package.

```ts
import { authStrategy } from '@breadai/auth-trusted'

const strategy = authStrategy({
  jwksUri: 'https://gateway.example/.well-known/jwks.json',
  issuer: 'https://gateway.example',
  audience: 'bread',       // optional
  header: 'authorization', // optional, default
  tenantClaim: 'tenant',   // optional
  algorithms: ['RS256'],   // optional — defaults to the asymmetric set above
})
```

`authenticate` reads that one header. It does not read `x-user-id`, `x-forwarded-user`, or
`x-forwarded-email`, and it does not delete them. A missing header, a bad signature, an `iss`
mismatch, a failed audience check, or a missing or empty `sub` returns null. It does not invent
a subject. Unlike `@breadai/auth-jwt`'s `authStrategy`, a missing `sub` does not become the
subject `jwt`.

On success the identity is `{ subject: sub, claims: payload, principal: { iss, sub, tenant? } }`.
`iss` and `sub` are the verified claims. `tenant` is set only when `tenantClaim` is configured
and that claim is a non-empty string. A configured claim that is missing, empty, or not a string
returns null. When `tenantClaim` is omitted, `tenant` stays unset even if the payload carries a
tenant-like claim.

Construction throws when `jwksUri` or `issuer` is missing, when `audience` or `tenantClaim` is an
empty string, when `jwksUri` is not a valid URL, when it is not `https` or `http` on loopback
(`localhost`, `127.0.0.1`, or `::1`), or when `algorithms` includes a symmetric algorithm or
`none`. Omitting `audience` or `tenantClaim` does not throw and leaves that option unset.

## Guarding the server

`@breadai/server`'s `authPlugin()` turns one or more strategies into a `BreadPlugin` named `auth`.
Drop it into `config.plugins`: it rejects any request none of the strategies authenticate (`401`)
and stashes the identity on the request context. That identity is what `server.authorize` receives.
Arbitrary middleware does not count as auth — only a plugin whose `name` is `auth`. Applying
`authMiddleware` by hand does not.

A verified strategy may set `AuthIdentity.principal` (`iss` and `sub`, both required, and an
optional `tenant`). It carries no email, name, or roles. `POST /agents/:id/run` and
`POST /pipelines/:id/run` copy that principal onto the run and ignore a `principal` field on the
JSON body. With no auth, those two routes still stamp `{ iss: "https://bread.local/cli", sub: "local" }`,
because the request reached them only on loopback. `ag-ui.run` does the same when the request has
no identity. When auth is configured, `run.start`, `pipeline.start`, `run.resume`, `run.stream`,
`run.cancel`, and `ag-ui.run` are `403` if `identity.principal` is missing, including an API key.
Session, loop, task, and MCP HTTP are not rejected for a missing principal. When `identity.principal` is set,
`POST /resume/:checkpointId` is `404`, the same as a missing checkpoint, unless the checkpoint's
stored principal is visible (`iss` and `sub`) and `runVisible` passes for the suspended run.
In-process callers pass
`RunOptions.principal` to `run`, `runPipeline`, and `runTask`. Resume uses the principal stored
on the checkpoint and does not take one as an argument. `@breadai/auth-trusted` sets it from
the verified gateway token. `@breadai/auth-jwt` sets `iss` and `sub` with no tenant from
`authStrategy`, and `iss`, `sub`, and an optional `tenant` from `oidcStrategy`.
`@breadai/auth-oauth2` verifies through `authStrategy`, so it sets that principal.
`@breadai/auth-api-key` does not. Tools read it as
[`principal`](./tools.md#toolcontext) on `ToolContext`.

One middleware in `createServer`, installed after plugin middleware and before plugin routes, the
transport mount, and the server routes, decides every request.

With a plugin named `auth`, that middleware calls `server.authorize(identity, action, args)`.
`identity` is the stored `AuthIdentity`. `action` is a string. `args` is path params plus query
params; a path param wins when a key appears in both. Return `true` to allow. Returning `true`
allows every action except `run.start`, `pipeline.start`, `run.resume`, `run.stream`, and
`run.cancel`, which still require `identity.principal`. `ag-ui.run` is not in that middleware check. Its handler returns `403`
before the run when the principal is missing, and copies `identity.principal` onto the run.
`false`, or a missing function, is `403` `{ "error": "Forbidden" }` before
the handler. The function may look at `args.id` and return `false`. `authorize` does not return an id
list, does not filter list rows, and does not apply a row predicate. Session routes still hide
rows from another principal; see [sessions](./sessions.md#ownership).

The constants are in [Core actions](./http-api.md#core-actions) and
[Plugin actions](./http-api.md#plugin-actions). Core does not list plugin names. A plugin that
still calls `app.get` or `app.post` directly leaves an unnamed route, and an unnamed route is
`403` when auth is on.

`authorizeStream` on the run stream and on cancel still runs after this grant and after the run
owner check (see [sessions](./sessions.md#ownership)).

With no plugin named `auth`, `server.authorize` is not called. The request is allowed only when
the `Host` header is loopback. Loopback is exactly `localhost`, `127.0.0.1`, or `::1`,
case-insensitive, with an optional numeric port. Bracketed `::1` counts (`[::1]`, `[::1]:3000`).
A trailing-dot name (`localhost.`), `127.1`, `0.0.0.0`, and `::` do not. `X-Forwarded-Host` is
ignored. Anything else is `403` `{ "error": "Forbidden" }`.

`createServer` does not throw, so an in-process caller can still use `app.request`. The listen
adapters check before the socket opens. No auth and a loopback bind warns that a reverse proxy on
the same machine can present `Host` `localhost`, `127.0.0.1`, or `[::1]`, and listens. That
exemption is not a network boundary. Every other combination throws `AUTH_NOT_CONFIGURED` and does
not listen. That includes auth without `server.authorize` (any bind), `server.authorize` without
auth on a public bind, and neither on a public bind.

```ts
// bread.config.ts
import { defineConfig, HTTP_ACTIONS } from '@breadai/core'
import { A2A_ACTIONS } from '@breadai/protocol-a2a-server'
import { authStrategy } from '@breadai/auth-api-key'
import { authPlugin } from '@breadai/server'

export default defineConfig({
  entrypoints: ['researcher'],
  server: {
    authorize(_identity, action, args) {
      if (action === HTTP_ACTIONS.sessionRead) return args.id === 'mine'
      if (action === A2A_ACTIONS.card) return true
      return false
    },
  },
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
