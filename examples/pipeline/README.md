# pipeline

`article` is unchanged: the researcher outlines, then `map` fans sections out to the writer. This example does not set `blobStore`, so a model that generates a file still throws `BLOB_STORE_NOT_CONFIGURED`.

`transcript` transcribes an http(s) `FileOutput` only when that URL is one the blob store issued, then that same writer reads the transcript text. Add a blob store such as `@breadai/store-s3` before running it. This example does not set one. Install `@ai-sdk/openai` and set `OPENAI_API_KEY` when you do. See [pipelines](../../docs/pipelines.md#transcription).

```bash
curl -N -X POST localhost:3000/pipelines/article/run -d '{"input":{"topic":"bread"}}'
```
