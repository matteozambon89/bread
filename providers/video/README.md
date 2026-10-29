<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/provider-video

The 13 catalog video providers, packaged as a `VideoRegistry` for `config.video`. This is not
`config.providers` — that registry returns a `LanguageModel`. Each entry is imported lazily on
first use, so installing this package does not pull in every SDK. You still `bun add` only the
peer you call.

```bash
bun add @breadai/provider-video
bun add @ai-sdk/fal   # only the providers you use
```

```ts
import { defineConfig } from '@breadai/core'
import { providerVideo } from '@breadai/provider-video'

export default defineConfig({
  entrypoints: ['writer'],
  video: providerVideo,
})
```

A factory returns that peer's experimental video model: `instance.video(modelId)`. It does not
invent a second job protocol. There is no `openai-compatible` entry, and no LiveKit or AI Gateway
entry. `google`, `google-vertex`, and `xai` reuse the language-model catalog key.
`google-vertex` calls the `vertex` export.

| Key | Package | Instance | Auth |
| --- | --- | --- | --- |
| `google` | `@ai-sdk/google` | `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `google-vertex` | `@ai-sdk/google-vertex` | `vertex` | `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`. Optional `GOOGLE_VERTEX_API_KEY` (express mode). |
| `xai` | `@ai-sdk/xai` | `xai` | `XAI_API_KEY` |
| `alibaba` | `@ai-sdk/alibaba` | `alibaba` | `ALIBABA_API_KEY` |
| `fal` | `@ai-sdk/fal` | `fal` | `FAL_API_KEY`, or `FAL_KEY` when that is unset |
| `replicate` | `@ai-sdk/replicate` | `replicate` | `REPLICATE_API_TOKEN` |
| `black-forest-labs` | `@ai-sdk/black-forest-labs` | `blackForestLabs` | `BFL_API_KEY` |
| `bytedance` | `@ai-sdk/bytedance` | `byteDance` | `ARK_API_KEY` |
| `klingai` | `@ai-sdk/klingai` | `klingai` | `KLINGAI_API_KEY`. Legacy pair: `KLINGAI_ACCESS_KEY` and `KLINGAI_SECRET_KEY`. |
| `minimax` | `@ai-sdk/minimax` | `minimax` | `MINIMAX_API_KEY` |
| `prodia` | `@ai-sdk/prodia` | `prodia` | `PRODIA_TOKEN` |
| `topaz` | `@ai-sdk/topaz` | `topaz` | `TOPAZ_API_KEY` |
| `heygen` | `@ai-sdk/heygen` | `heygen` | `HEYGEN_API_KEY` |

A missing peer throws `MISSING_PROVIDER` and names the package to `bun add`. Spreading the
registry does not import anything.

A pipeline step `{ type: 'video', provider, model }` reads the current value as a string prompt.
It requires `config.blobStore`. It resolves the model and passes that string on. It does not call
`experimental_generateVideo` or `experimental_startVideo`, and it does not store bytes. Chain it
after an agent that returns a string, the same shape as the
[pipeline example](https://github.com/matteozambon89/bread/tree/HEAD/examples/pipeline). That
example is unchanged.

```ts
import { createFal } from '@ai-sdk/fal'
import { providerVideo } from '@breadai/provider-video'

video: {
  ...providerVideo,
  'fal-eu': (modelId) => createFal({ baseURL: 'https://fal.example' }).video(modelId),
}
```

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [providers](https://matteozambon89.github.io/bread/providers.html#video-models) ·
[pipelines](https://matteozambon89.github.io/bread/pipelines.html#video) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
