<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @bread/auth-api-key

API-key auth for bread — `authStrategy()` verifies an incoming request's key timing-safely,
`signer()` attaches a key to outgoing requests. Same options shape for both.

```bash
bun add @bread/auth-api-key   # or: npm i @bread/auth-api-key
```

```ts
import { authStrategy, signer } from '@bread/auth-api-key'

const strategy = authStrategy({
  scheme: 'Bearer',              // omit for a raw x-api-key-style header
  keys: [process.env.API_KEY!],
  // or resolve from a credential provider instead of a static list:
  // credentials: envProvider(), credentialName: 'API_KEY',
})
```

Pass `strategy` to `@bread/server`'s `authPlugin()` to guard a running server.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [auth](https://github.com/matteozambon89/bread/blob/HEAD/docs/auth.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
