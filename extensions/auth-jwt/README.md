<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/auth-jwt

JWT auth for bread — verifies incoming bearer tokens via [`jose`](https://github.com/panva/jose).
`authStrategy` takes an HS256 symmetric secret or one remote JWKS (RS/PS/ES). `oidcStrategy`
discovers one or more OpenID Connect issuers and maps a vendor tenant claim onto `principal`.
Verification only — no `signer`.

```bash
bun add @breadai/auth-jwt   # or: npm i @breadai/auth-jwt
```

```ts
import { authStrategy, oidcStrategy } from '@breadai/auth-jwt'

const strategy = authStrategy({
  secret: process.env.JWT_SECRET,                   // HS256, or:
  jwksUri: 'https://issuer/.well-known/jwks.json',  // RS/PS/ES via remote JWKS
  issuer: 'urn:my:issuer',
  audience: 'urn:my:api',
})

const oidc = oidcStrategy({
  issuers: [
    {
      issuer: 'https://login.microsoftonline.com/{tenant}/v2.0',
      audience: 'api://bread',
      preset: 'entra',
    },
    {
      issuer: 'https://my.auth0.com/',
      audience: 'client-id',
      preset: 'auth0',
    },
  ],
})
```

`authStrategy` resolves `{ subject: payload.sub ?? 'jwt', claims: payload }` and, when `iss` and
`sub` are both non-empty strings, `principal: { iss, sub }` with no tenant. A missing `sub` stays
the subject `jwt` and sets no principal.

`oidcStrategy` resolves `{ subject: sub, claims: payload, principal: { iss, sub, tenant? } }`.
`sub` must be a non-empty string. Presets copy `tid` (Entra), `custom:tenant` (Cognito), `hd`
(Google), or `org_id` (Auth0) when that claim is a non-empty string. A missing preset claim still
authenticates, with `tenant` unset. Okta and Keycloak set no tenant claim unless `tenantClaim` is
set. An explicit `tenantClaim` that is missing or empty rejects the token. Roles stay on `claims`.
A `google` preset configured as `https://accounts.google.com` accepts that `iss` and
`accounts.google.com`; `principal.iss` is the token's `iss`. Discovery does not follow redirects.
Pass `strategy` to `@breadai/server`'s `authPlugin()` to guard a running server.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [auth](https://matteozambon89.github.io/bread/auth.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
