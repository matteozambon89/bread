# pipeline

A two-step pipeline: researcher outlines, then `map` fans sections out to the writer.

`cover` runs that same writer, then an image step. The writer's paragraph is the prompt. The step stores the image with `blobStore` and passes the `FileOutput` on. `BREAD_IMAGE_PROVIDER` and `BREAD_IMAGE_MODEL` override the default `openai` / `gpt-image-1` (use `openai-compatible` for a server that speaks the image API). Topaz needs a source image (`{ images }`), not this writer's paragraph.

```bash
curl -N -X POST localhost:3000/pipelines/article/run -d '{"input":{"topic":"bread"}}'
curl -N -X POST localhost:3000/pipelines/cover/run -d '{"input":"a loaf on a wooden board"}'
```

See [pipelines](../../docs/pipelines.md#image) and [providers](../../docs/providers.md#image-models).
