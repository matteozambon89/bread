<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/auth-trusted

Trusted-identity auth for bread — verifies one gateway JWT against a remote JWKS and sets
`principal`. One issuer, one JWKS, asymmetric only (RS/PS/ES/EdDSA). Verification only — no
`signer`. Unsigned identity headers are ignored. This package does not do mTLS.

```bash
bun add @breadai/auth-trusted   # or: npm i @breadai/auth-trusted
```

```ts
import { authStrategy } from '@breadai/auth-trusted'

const strategy = authStrategy({
  jwksUri: 'https://gateway.example/.well-known/jwks.json',
  issuer: 'https://gateway.example',
  audience: 'bread',     // optional
  tenantClaim: 'tenant', // optional
})
```

A verified token resolves to `{ subject, claims, principal }`, where `principal` is `{ iss, sub }`
and `tenant` only when `tenantClaim` names a non-empty string claim. A missing header, a bad
signature, an issuer or audience mismatch, or a missing or empty `sub` returns null. The strategy
does not read `x-user-id`, `x-forwarded-user`, or `x-forwarded-email`. Pass `strategy` to
`authPlugin()` from `@breadai/server` to guard a running server.

Construction throws when `jwksUri` or `issuer` is missing, when `audience` or `tenantClaim` is an
empty string, when `jwksUri` is not a valid URL, when it is not `https` or `http` on loopback
(`localhost`, `127.0.0.1`, or `::1`), or when `algorithms` includes a symmetric algorithm or
`none`. Omitting `audience` or `tenantClaim` does not throw and leaves that option unset.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [auth](https://matteozambon89.github.io/bread/auth.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
