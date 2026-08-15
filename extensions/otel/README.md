<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @bread/otel

OpenTelemetry plugin for bread — one `agent.run` span per run, a `tool.call.<name>` child span
per tool call (closed on result or error), and `pipeline.step.<n>` spans for pipeline steps.
Errors are recorded on their span via `recordException`.

```bash
bun add @bread/otel   # or: npm i @bread/otel
```

```ts
import { defineConfig } from '@bread/core'
import { otel } from '@bread/otel'

export default defineConfig({
  entrypoints: ['researcher'],
  plugins: [otel({ serviceName: 'my-bread-app' })],
})
```

The plugin only talks to `@opentelemetry/api` — register any tracer provider/exporter you like
(see the repo's `examples/otel` for a console-exporter setup), or pass your own `tracer`.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [otel](https://github.com/matteozambon89/bread/blob/HEAD/docs/otel.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
