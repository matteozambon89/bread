<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/provider-catalog

The 21 official built-in providers, packaged as a ready-made `ProviderRegistry` for
`config.providers`. Each entry is imported lazily on first use, so installing this package doesn't
pull in every SDK — you still `bun add` only the ones you actually use.

```bash
bun add @breadai/provider-catalog
bun add @ai-sdk/anthropic   # only the providers you use
```

```ts
import { defineConfig } from '@breadai/core'
import { providerCatalog } from '@breadai/provider-catalog'

export default defineConfig({
  entrypoints: ['writer'],
  providers: providerCatalog,
})
```

Core has no built-in providers of its own — `model.provider` resolves against whatever you register
in `providers` (global) or an agent's own `providers` (per-agent override, checked first). This
catalog supplies the common set: `openai` (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`),
`anthropic`, `google`, `google-vertex`, `azure`, `amazon-bedrock`, `mistral`, `groq`, `cohere`,
`xai`, `deepseek`, `togetherai`, `fireworks`, `deepinfra`, `cerebras`, `perplexity`, `baseten`,
`ollama`, `openrouter` (`OPENROUTER_API_KEY`, e.g. `openai/gpt-4o-mini`), `workers-ai`
(`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, e.g. `@cf/meta/llama-3.1-8b-instruct`),
`openai-compatible` (`OPENAI_COMPATIBLE_BASE_URL`, optional `OPENAI_COMPATIBLE_API_KEY`).

## Custom or additional instances

Spread the catalog and add your own named instances — e.g. a second account or region under a
different name:

```ts
import { createAnthropic } from '@ai-sdk/anthropic'
import { providerCatalog } from '@breadai/provider-catalog'

providers: {
  ...providerCatalog,
  'anthropic-eu': createAnthropic({ baseURL: 'https://eu.anthropic.example' }),
}
```

`openai-compatible` reads `OPENAI_COMPATIBLE_BASE_URL` (required) and optionally
`OPENAI_COMPATIBLE_API_KEY` (local servers often need no key). Point a model at it:

```ts
model: { provider: 'openai-compatible', model: '<id>' }
```

For a second named host, spread `createOpenAICompatible` under another key:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

providers: {
  ...providerCatalog,
  'my-host': createOpenAICompatible({ name: 'my-host', baseURL: 'https://my-host.example/v1' }),
}
```

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [agents](https://github.com/matteozambon89/bread/blob/HEAD/docs/agents.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
