# @breadai/transport-stdout

Terminal-rendering [`BreadTransport`](../../docs/transports.md) for [bread](https://github.com/matteozambon89/bread) —
the default renderer for `bread chat`/`bread invoke`. It's a `sink`: publish-only, no
subscribe/replay, since nothing "tails" a terminal.

## Install

```bash
bun add @breadai/transport-stdout
```

## Usage

```ts
// bread.config.ts
import { transport } from '@breadai/transport-stdout'

export default defineConfig({
  entrypoints: ['assistant'],
  store: store({ path: './bread.db' }),
  transport: transport(), // renders the conversation to stdout
})
```

### Options

| Option  | Default | Meaning                                                                 |
| ------- | ------- | ------------------------------------------------------------------------ |
| `trace` | `false` | Also print `tool:call` lines (`↳ toolName(args)`). Off by default — a plain conversational view of `text:delta` + errors only. |

## Semantics

- `text:delta` streams to stdout, labeled `agent ▸ ` once per run.
- `tool:call` prints only when `trace: true`.
- `tool:error`/`agent:error` print to stderr.
- `human:required` resets the label (chat's own prompt loop renders the question and blocks for
  input — a sink can't do that part).
