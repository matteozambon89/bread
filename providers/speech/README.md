<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/provider-speech

Twelve speech providers as a `SpeechRegistry` for `config.speech`. This is not a `ProviderRegistry`:
those factories return a `LanguageModel`. Each entry is an optional peer, imported on first use, so
installing this package does not pull in every SDK.

```bash
bun add @breadai/provider-speech
bun add @ai-sdk/openai   # only the providers you use
```

```ts
import { defineConfig } from '@breadai/core'
import { providerSpeech } from '@breadai/provider-speech'

export default defineConfig({
  entrypoints: ['reply'],
  speech: providerSpeech,
})
```

A pipeline step speaks the current string and passes a `FileOutput` on:

```ts
{ type: 'speech', provider: 'openai', model: 'tts-1' }
```

The step requires `config.blobStore`. Behavior, including `file:generated`, is documented on the
[speech step](https://matteozambon89.github.io/bread/pipelines.html#speech).

The catalog is exactly the keys below. `openai-compatible` has no speech factory and is not
included. `xai` and `hume` expose `speech()` with no model id; the step still passes `model`, and
those two ignore it.

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

A missing peer throws `MISSING_PROVIDER` and names `bun add <package>`. Spreading `providerSpeech`
does not import any of them.

[`examples/support-triage`](https://github.com/matteozambon89/bread/tree/HEAD/examples/support-triage)
pipeline `speak` runs a ticket lookup, the same decision step as `refund`, then `openai` / `tts-1`.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [providers](https://matteozambon89.github.io/bread/providers.html#speech) ·
[pipelines](https://matteozambon89.github.io/bread/pipelines.html#speech) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
