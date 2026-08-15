<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/auth-oauth2

OAuth 2.0 auth for bread — two independent factories, each its own option shape: `authStrategy()`
validates an incoming bearer token as a JWT (reusing `@breadai/auth-jwt`), `signer()` runs the
client-credentials grant with token caching.

```bash
bun add @breadai/auth-oauth2   # or: npm i @breadai/auth-oauth2
```

```ts
import { authStrategy, signer } from '@breadai/auth-oauth2'

// server side: validate incoming bearer tokens
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

Covers client-credentials + bearer-token verification only — authorization-code/PKCE, refresh, and
device-code flows are not implemented.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [auth](https://github.com/matteozambon89/bread/blob/HEAD/docs/auth.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
