# Providers

Core has no built-in model providers of its own — `model.provider` resolves against named
instances registered in `providers` (`BreadConfig.providers`, global) or an agent's own
`providers` (`AgentConfig.providers`, checked first, wins on a name collision).

## The built-in catalog

Install [`@breadai/provider-llm`](https://www.npmjs.com/package/@breadai/provider-llm) for the
21 common built-ins (`openai`, `anthropic`, `google`, `google-vertex`, `azure`,
`amazon-bedrock`, `mistral`, `groq`, `cohere`, `xai`, `deepseek`, `togetherai`, `fireworks`,
`deepinfra`, `cerebras`, `perplexity`, `baseten`, `ollama`, `openrouter`, `workers-ai`,
`openai-compatible`), each imported lazily so only the provider you actually use pulls in its
optional peer dependency. `@breadai/provider-catalog` re-exports `providerLlm` and
`providerEntries` from that package. `openai` reads `OPENAI_API_KEY` and optionally `OPENAI_BASE_URL`.
`openrouter` reads `OPENROUTER_API_KEY` (e.g. `openai/gpt-4o-mini`). `workers-ai` reads
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (e.g. `@cf/meta/llama-3.1-8b-instruct`).
`openai-compatible` reads `OPENAI_COMPATIBLE_BASE_URL` and optionally `OPENAI_COMPATIBLE_API_KEY`.

```ts
import { defineConfig } from '@breadai/core'
import { providerLlm } from '@breadai/provider-llm'

export default defineConfig({
  entrypoints: ['writer'],
  providers: providerLlm,
})
```

Point a model at a local or self-hosted OpenAI-compatible server with
`model: { provider: 'openai-compatible', model: '<id>' }` and `OPENAI_COMPATIBLE_BASE_URL`
(optional `OPENAI_COMPATIBLE_API_KEY` — local servers often need no key). For a second named host,
spread `createOpenAICompatible` into `providers` under whatever name you like.

## Bring your own

`providers` is a plain `ProviderRegistry` — a map of provider-key to a factory taking a model id
and returning a `LanguageModel`. Hand-write one to add a provider the catalog doesn't cover, or to
override a catalog entry:

```ts
import type { ProviderRegistry } from '@breadai/core'
import { openai } from '@ai-sdk/openai'

const providers: ProviderRegistry = {
  openai: (modelId) => openai(modelId),
}
```

## Running the examples against a local model

Every agent and task under [`examples/`](https://github.com/matteozambon89/bread/tree/HEAD/examples) takes the same two env overrides, so an
example can be driven end to end without a cloud API key:

```ts
model: {
  provider: process.env.BREAD_PROVIDER ?? 'anthropic',
  model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
},
```

With neither set, every example resolves `anthropic/claude-opus-4-8` as before. Point them at a
local [Ollama](https://ollama.com) instead:

```bash
BREAD_PROVIDER=ollama BREAD_MODEL=gemma4:e2b bread dev --idle-timeout 240
```

`gemma4:e2b` is the recommended local default — it's the smallest model verified on both axes the
examples need: schema-compliant structured output (`generateObject`, e.g.
`examples/knowledge-graph`'s task) *and* reliable tool calling on blunt instructions (HITL
approval, loop tools, `core_delegate`). Every example already spreads `providerLlm`, whose
`ollama` entry is lazy, so its optional peer (`ollama-ai-provider-v2`) is the only extra install —
already a dependency of each example.

Two caveats worth knowing before you read too much into a local run:

- **Schema-valid is not semantically right**, and small models fail semantically first — they'll
  happily put a plausible-looking wrong value in a well-typed field. For examples where the
  *output quality* is the demonstration (`examples/pipeline`'s `CustomFormat` line-splitting,
  `examples/knowledge-graph`'s entity extraction), use a larger local model such as
  `gemma4:latest`. `e2b` answers "is the wiring correct", which is what most verification needs.
- **Raise `--idle-timeout`.** Bun's 10-second default kills a slow local-model run mid-stream and
  surfaces it as `RUN_CANCELLED`. Bun rejects anything above **255**, so 240 is a practical
  ceiling — a local model that needs longer than that per step wants a smaller model, not a bigger
  timeout.

## Resolution and errors

Per-agent `providers` is checked first; the global `BreadConfig.providers` is the fallback. An
unresolvable `model.provider` throws `UNKNOWN_PROVIDER` naming whatever *is* registered, so a
missing catalog import fails loudly at run time rather than silently picking the wrong model.

See [agents.md](./agents.md#providers) for where `model`/`providers` sit in `AgentConfig`.
Decision hosts are a separate registry, `config.decisions` — see [decisions.md](./decisions.md).

## Embedding models

`providers` returns a `LanguageModel`. Embeddings are not that registry.
`BreadConfig.embeddings` is an `EmbeddingRegistry`: a provider name to a factory
that takes a model id and returns an AI SDK `EmbeddingModel`.

Install [`@breadai/provider-embeddings`](https://www.npmjs.com/package/@breadai/provider-embeddings)
for 16 lazily-imported peers. A key that also exists on `@breadai/provider-llm`
uses that same name. `voyage` and `alibaba` are embedding-only.
Language-model-only keys (`anthropic`, `groq`, `xai`, `deepseek`, `cerebras`,
`openrouter`, `workers-ai`) are not included.

```ts
import { defineConfig } from '@breadai/core'
import { providerEmbeddings } from '@breadai/provider-embeddings'

export default defineConfig({
  entrypoints: ['memory'],
  embeddings: providerEmbeddings,
})
```

| Key | Package | Auth |
| --- | --- | --- |
| `openai` | `@ai-sdk/openai` | `OPENAI_API_KEY`. Optional `OPENAI_BASE_URL`. |
| `azure` | `@ai-sdk/azure` | `AZURE_API_KEY`, `AZURE_RESOURCE_NAME` |
| `google` | `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `google-vertex` | `@ai-sdk/google-vertex` | `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS` |
| `amazon-bedrock` | `@ai-sdk/amazon-bedrock` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| `mistral` | `@ai-sdk/mistral` | `MISTRAL_API_KEY` |
| `cohere` | `@ai-sdk/cohere` | `COHERE_API_KEY` |
| `togetherai` | `@ai-sdk/togetherai` | `TOGETHER_AI_API_KEY` |
| `fireworks` | `@ai-sdk/fireworks` | `FIREWORKS_API_KEY` |
| `deepinfra` | `@ai-sdk/deepinfra` | `DEEPINFRA_API_KEY` |
| `perplexity` | `@ai-sdk/perplexity` | `PERPLEXITY_API_KEY` |
| `baseten` | `@ai-sdk/baseten` | `BASETEN_API_KEY` |
| `ollama` | `ollama-ai-provider-v2` | None. Local server. Optional `OLLAMA_BASE_URL`. |
| `openai-compatible` | `@ai-sdk/openai-compatible` | `OPENAI_COMPATIBLE_BASE_URL`. Optional `OPENAI_COMPATIBLE_API_KEY`. |
| `voyage` | `@ai-sdk/voyage` | `VOYAGE_API_KEY` |
| `alibaba` | `@ai-sdk/alibaba` | `ALIBABA_API_KEY` |

`ollama` is the local embedding provider. `openai-compatible` is the escape hatch
for a server that speaks the embeddings API: the factory calls
`createOpenAICompatible(...).embeddingModel(modelId)`. Spread your own
`embeddingModel` factory under another key for a second host.

Registering `embeddings` does not turn on vector search. Postgres still takes a
hand-written `embed` function, and SQLite and memory stay keyword-only. See
[store.md](./store.md#semantic-vector-search).
[`examples/knowledge-graph`](https://github.com/matteozambon89/bread/tree/HEAD/examples/knowledge-graph)
spreads `providerEmbeddings` next to its document and knowledge auto-inject and
leaves the SQLite store keyword-only.
