<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/provider-embeddings

16 embedding providers, packaged as an `EmbeddingRegistry` for `config.embeddings`.
Each entry is imported lazily on first use and returns an AI SDK `EmbeddingModel`.
Installing this package does not pull in every SDK — `bun add` only the ones you use.

This is not `config.providers`. That registry returns a `LanguageModel`.

```bash
bun add @breadai/provider-embeddings
bun add @ai-sdk/openai   # only the providers you use
```

```ts
import { defineConfig } from '@breadai/core'
import { providerEmbeddings } from '@breadai/provider-embeddings'

export default defineConfig({
  entrypoints: ['memory'],
  embeddings: providerEmbeddings,
})
```

Keys that `@breadai/provider-llm` already uses keep that name: `openai`
(`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`), `azure`, `google`, `google-vertex`,
`amazon-bedrock`, `mistral`, `cohere`, `togetherai`, `fireworks`, `deepinfra`,
`perplexity`, `baseten`, `ollama`, `openai-compatible`. Embedding-only keys are
`voyage` (`VOYAGE_API_KEY`) and `alibaba` (`ALIBABA_API_KEY`). Not included: `anthropic`,
`groq`, `xai`, `deepseek`, `cerebras`, `openrouter`, `workers-ai`.

`ollama` (`ollama-ai-provider-v2`) is the local embedding provider. `OLLAMA_BASE_URL`
is optional.

`openai-compatible` is the escape hatch for a server that speaks the embeddings
API. It reads `OPENAI_COMPATIBLE_BASE_URL` (required) and optionally
`OPENAI_COMPATIBLE_API_KEY`, builds a provider with `createOpenAICompatible`, and
returns that provider's `embeddingModel(modelId)`.

```ts
await providerEmbeddings['openai-compatible']('text-embedding-3-small')
```

Registering `embeddings` does not turn on vector search. Postgres still takes a
hand-written `(text: string) => Promise<number[]>` `embed` function. A
`{ provider, model }` ref is not that function. SQLite and memory stay
keyword-only. See [store](https://matteozambon89.github.io/bread/store.html).

## Custom or additional instances

Spread the catalog and add your own named factory:

```ts
import { providerEmbeddings } from '@breadai/provider-embeddings'

embeddings: {
  ...providerEmbeddings,
  'my-host': (modelId) => myProvider.embeddingModel(modelId),
}
```

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Source: [providers/embeddings](https://github.com/matteozambon89/bread/tree/HEAD/providers/embeddings).
Docs: [providers](https://matteozambon89.github.io/bread/providers.html) ·
[store](https://matteozambon89.github.io/bread/store.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
