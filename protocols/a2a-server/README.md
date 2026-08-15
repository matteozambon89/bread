<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @bread/protocol-a2a-server

Agent-to-agent (A2A) protocol plugin for bread.

```bash
bun add @bread/protocol-a2a-server   # or: npm i @bread/protocol-a2a-server
```

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [A2A server](https://github.com/matteozambon89/bread/blob/HEAD/docs/a2a.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## Usage

```ts
import { a2aServer } from '@bread/protocol-a2a-server'

// v0.3.x (default) — the interoperable spec version
a2aServer({ agentId: 'researcher', url: 'https://api.example.com/a2a' })

// v1.0 — its JSON-RPC binding only
a2aServer({ agentId: 'researcher', url: 'https://api.example.com/a2a-v1', specVersion: '1.0' })
```

## License

MIT © Matteo Zambon
