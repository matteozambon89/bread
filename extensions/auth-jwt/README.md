<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/auth-jwt

JWT auth for bread — verifies incoming bearer tokens via [`jose`](https://github.com/panva/jose),
either an HS256 symmetric secret or a remote JWKS (RS/ES). Verification only — no `signer`.

```bash
bun add @breadai/auth-jwt   # or: npm i @breadai/auth-jwt
```

```ts
import { authStrategy } from '@breadai/auth-jwt'

const strategy = authStrategy({
  secret: process.env.JWT_SECRET,                   // HS256, or:
  jwksUri: 'https://issuer/.well-known/jwks.json',  // RS/ES via remote JWKS
  issuer: 'urn:my:issuer',
  audience: 'urn:my:api',
})
```

The resolved identity carries the full claims: `{ subject: payload.sub, claims: payload }`. Pass
`strategy` to `@breadai/server`'s `authPlugin()` to guard a running server.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [auth](https://github.com/matteozambon89/bread/blob/HEAD/docs/auth.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
