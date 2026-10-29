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

## Speech

Speech models are not language models. `config.providers` returns a `LanguageModel`.
`config.speech` is a `SpeechRegistry`: a map of provider name to a factory
`(modelId: string) => SpeechModel | Promise<SpeechModel>`. A speech pipeline step names
`provider` and `model`. Core has no built-in speech providers.

Install
[`@breadai/provider-speech`](https://github.com/matteozambon89/bread/tree/HEAD/providers/speech).
Each entry is an optional peer, imported on first use, same as `@breadai/provider-llm`.

```ts
import { defineConfig } from '@breadai/core'
import { providerSpeech } from '@breadai/provider-speech'

export default defineConfig({
  entrypoints: ['reply'],
  speech: providerSpeech,
})
```

The catalog is exactly these twelve. `openai-compatible` has no speech factory and is not included.
`xai` and `hume` expose `speech()` with no model id; the step still passes `model`, and those two
ignore it.

| Key | Package | Auth |
| --- | --- | --- |
| `openai` | `@ai-sdk/openai` | `OPENAI_API_KEY` |
| `azure` | `@ai-sdk/azure` | `AZURE_API_KEY`, `AZURE_RESOURCE_NAME` |
| `google` | `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `google-vertex` | `@ai-sdk/google-vertex` | `GOOGLE_VERTEX_API_KEY`, `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION` |
| `mistral` | `@ai-sdk/mistral` | `MISTRAL_API_KEY` |
| `xai` | `@ai-sdk/xai` | `XAI_API_KEY` |
| `elevenlabs` | `@ai-sdk/elevenlabs` | `ELEVENLABS_API_KEY` |
| `deepgram` | `@ai-sdk/deepgram` | `DEEPGRAM_API_KEY` |
| `cartesia` | `@ai-sdk/cartesia` | `CARTESIA_API_KEY` |
| `hume` | `@ai-sdk/hume` | `HUME_API_KEY` |
| `fish-audio` | `@ai-sdk/fish-audio` | `FISH_AUDIO_API_KEY` |
| `fal` | `@ai-sdk/fal` | `FAL_API_KEY`, or `FAL_KEY` when that is unset |

A missing peer throws `MISSING_PROVIDER` and names `bun add <package>`. The step that calls
`generateSpeech` is documented in [pipelines.md](./pipelines.md#speech).
