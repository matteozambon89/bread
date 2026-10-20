<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/auth-trusted

Trusted-identity auth for bread — verifies one gateway JWT against a remote JWKS, or an mTLS
client certificate, and sets `principal`. Verification only — no `signer`. Unsigned identity
headers are ignored and are not deleted.

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

## mTLS

`mtlsStrategy` is named `trusted-mtls`. `issuer` is the leaf issuer CN, matched exactly, and
becomes `principal.iss` — not a URI. `principal.sub` and `subject` are the subject CN. `claims`
includes `fingerprint256`. `Principal` gains no fields. The strategy does not install
`authPlugin`.

```ts
import { mtlsStrategy } from '@breadai/auth-trusted'

const strategy = mtlsStrategy({
  issuer: 'gateway-ca',
  tenantField: 'ou', // optional
})
```

Set `server.tls` to PEM contents (`key`, `cert`, `ca`), not paths, and pass `strategy` to
`authPlugin()`. Both listen adapters then require a verified client certificate. There is no
option to skip verification. A partial or empty `key`, `cert`, or `ca` throws
`TLS_NOT_CONFIGURED` before listen. Omit `tls` and the bind stays plain HTTP, with no peer
attached.

`tenantField: 'ou'` copies a single OU onto `principal.tenant`. A missing, empty, or
multi-value OU returns null. Omitting `tenantField` leaves `tenant` unset. No attached peer,
an issuer mismatch, or an empty CN returns null. The strategy does not read or delete
`x-user-id`, `x-forwarded-user`, `x-forwarded-email`, `ssl-client-cert`, or
`x-forwarded-client-cert`.

Construction throws when `issuer` is missing or empty, or when `tenantField` is empty or any
value other than `ou`.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [auth](https://matteozambon89.github.io/bread/auth.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
