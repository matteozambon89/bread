# Providers

Core has no built-in model providers of its own — `model.provider` resolves against named
instances registered in `providers` (`BreadConfig.providers`, global) or an agent's own
`providers` (`AgentConfig.providers`, checked first, wins on a name collision).

## The built-in catalog

Install [`@breadai/provider-catalog`](https://www.npmjs.com/package/@breadai/provider-catalog) for the
18 common `@ai-sdk/*` built-ins (`openai`, `anthropic`, `google`, `google-vertex`, `azure`,
`amazon-bedrock`, `mistral`, `groq`, `cohere`, `xai`, `deepseek`, `togetherai`, `fireworks`,
`deepinfra`, `cerebras`, `perplexity`, `baseten`, `ollama`), each imported lazily so only the
provider you actually use pulls in its optional peer dependency:

```ts
import { defineConfig } from '@breadai/core'
import { providerCatalog } from '@breadai/provider-catalog'

export default defineConfig({
  entrypoints: ['writer'],
  providers: providerCatalog,
})
```

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

Every agent and task under [`examples/`](../examples) takes the same two env overrides, so an
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
approval, loop tools, `core_delegate`). Every example already spreads `providerCatalog`, whose
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
