<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/provider-transcription

15 transcription providers as a `TranscriptionRegistry` for `config.transcription`. Each entry is imported lazily on first use and returns an AI SDK `TranscriptionModel` from `.transcription(modelId)`. This registry is separate from `config.providers`.

```bash
bun add @breadai/provider-transcription
bun add @ai-sdk/openai   # only the providers you use
```

```ts
import { defineConfig } from '@breadai/core'
import { providerTranscription } from '@breadai/provider-transcription'

export default defineConfig({
  entrypoints: ['writer'],
  transcription: providerTranscription,
})
```

A pipeline step names one key and a model id. The step passes an http(s) `FileOutput` URL to `transcribe` and the next step reads the transcript text. See [pipelines](https://matteozambon89.github.io/bread/pipelines.html#transcription).

| Key | Package | Auth |
| --- | --- | --- |
| `openai` | `@ai-sdk/openai` | `OPENAI_API_KEY`. Optional `OPENAI_BASE_URL`. |
| `azure` | `@ai-sdk/azure` | `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`. |
| `google` | `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY`. |
| `google-vertex` | `@ai-sdk/google-vertex` | `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`. Optional `GOOGLE_VERTEX_API_KEY`. |
| `mistral` | `@ai-sdk/mistral` | `MISTRAL_API_KEY`. |
| `groq` | `@ai-sdk/groq` | `GROQ_API_KEY`. |
| `xai` | `@ai-sdk/xai` | `XAI_API_KEY`. |
| `elevenlabs` | `@ai-sdk/elevenlabs` | `ELEVENLABS_API_KEY`. |
| `deepgram` | `@ai-sdk/deepgram` | `DEEPGRAM_API_KEY`. |
| `cartesia` | `@ai-sdk/cartesia` | `CARTESIA_API_KEY`. |
| `fish-audio` | `@ai-sdk/fish-audio` | `FISH_AUDIO_API_KEY`. |
| `assemblyai` | `@ai-sdk/assemblyai` | `ASSEMBLYAI_API_KEY`. |
| `gladia` | `@ai-sdk/gladia` | `GLADIA_API_KEY`. The SDK method takes no model id; the step still requires `model`, and Gladia uses its single model. |
| `revai` | `@ai-sdk/revai` | `REVAI_API_KEY`. |
| `fal` | `@ai-sdk/fal` | `FAL_API_KEY`, or `FAL_KEY` when that is unset. |

There is no `openai-compatible` transcription factory. LiveKit and the AI Gateway are not keys. A missing peer throws `MISSING_PROVIDER`.

[`examples/pipeline`](https://github.com/matteozambon89/bread/tree/HEAD/examples/pipeline) runs `transcript`, then the writer.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [providers](https://matteozambon89.github.io/bread/providers.html#transcription) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
