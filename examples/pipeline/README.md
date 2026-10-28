# pipeline

`article` is unchanged: the researcher outlines, then `map` fans sections out to the writer.

`transcript` transcribes an http(s) `FileOutput`, then that same writer reads the transcript text. The step needs `config.blobStore`. This example's store only marks it set — the step does not call `get`. Install `@ai-sdk/openai` and set `OPENAI_API_KEY` before running `transcript`. See [pipelines](../../docs/pipelines.md#transcription).

```bash
curl -N -X POST localhost:3000/pipelines/article/run -d '{"input":{"topic":"bread"}}'
curl -N -X POST localhost:3000/pipelines/transcript/run \
  -d '{"input":{"kind":"file","uri":"https://example.com/clip.mp3","mimeType":"audio/mpeg"}}'
```
