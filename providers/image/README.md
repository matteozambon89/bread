<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/provider-image

Eighteen image providers as an `ImageRegistry` for `config.image`. Each factory returns an AI SDK `ImageModel` via `provider.image(modelId)` (or `imageModel` for `openai-compatible`). Importing this package does not load every SDK — `bun add` only the ones you use.

```bash
bun add @breadai/provider-image
bun add @ai-sdk/openai
```

```ts
import { defineConfig } from '@breadai/core'
import { providerImage } from '@breadai/provider-image'

export default defineConfig({
  image: providerImage,
  pipelines: {
    cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }],
  },
})
```

The image step needs `config.blobStore` and a prompt: a string, or `{ text?, images, mask? }` when the model needs a source image. Topaz ignores text and requires `images`. It calls `generateImage` once (`n: 1`, `maxRetries: 0`), stores the bytes, emits `file:generated`, and passes the `FileOutput` on. These factories are not `config.providers` — that registry returns a `LanguageModel`.

| Key | Auth |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `azure` | `AZURE_API_KEY`, `AZURE_RESOURCE_NAME` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `google-vertex` | `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS` |
| `amazon-bedrock` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| `xai` | `XAI_API_KEY` |
| `togetherai` | `TOGETHER_AI_API_KEY` (also `TOGETHER_API_KEY`) |
| `fireworks` | `FIREWORKS_API_KEY` |
| `deepinfra` | `DEEPINFRA_API_KEY` |
| `fal` | `FAL_API_KEY` (also `FAL_KEY`) |
| `luma` | `LUMA_API_KEY` |
| `replicate` | `REPLICATE_API_TOKEN` |
| `black-forest-labs` | `BFL_API_KEY` |
| `bytedance` | `ARK_API_KEY` |
| `prodia` | `PRODIA_TOKEN` |
| `topaz` | `TOPAZ_API_KEY` |
| `quiverai` | `QUIVERAI_API_KEY` |
| `openai-compatible` | `OPENAI_COMPATIBLE_BASE_URL`, optional `OPENAI_COMPATIBLE_API_KEY` |

A missing peer throws `MISSING_PROVIDER`. `openai-compatible` throws `PROVIDER_NOT_CONFIGURED` when `OPENAI_COMPATIBLE_BASE_URL` is unset and the package is installed. Spread the catalog to add another host:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

image: {
  ...providerImage,
  'my-host': (modelId) =>
    createOpenAICompatible({ name: 'my-host', baseURL: 'https://my-host.example/v1' }).imageModel(modelId),
}
```

[`examples/pipeline`](https://github.com/matteozambon89/bread/tree/HEAD/examples/pipeline) pipeline `cover` runs the writer, then an image step.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [providers](https://matteozambon89.github.io/bread/providers.html#image-models) ·
[pipelines](https://matteozambon89.github.io/bread/pipelines.html#image) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
