<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/store-s3

S3-backed `BlobStore` for bread — binary/file content storage via presigned URLs. Works against
AWS S3 or any S3-compatible service (Cloudflare R2, MinIO, ...) via a custom `endpoint`. A separate,
optional seam from `BreadStore` — plug it in as `config.blobStore`, not `config.store`.

```bash
bun add @breadai/store-s3
```

```ts
import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-postgres'
import { store as blobStore } from '@breadai/store-s3'

export default defineConfig({
  entrypoints: ['assistant'],
  store: store(),
  blobStore: blobStore({ bucket: 'my-bucket', region: 'us-east-1' }),
})
```

Credentials default to the AWS SDK's standard credential chain (env vars, IAM role,
`~/.aws/credentials`) — pass `credentials` explicitly to override. `put()` generates its own key
(you never invent one) and returns a presigned GET URL, valid for `presignedUrlExpiresInSeconds`
(default 3600).

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [store](https://github.com/matteozambon89/bread/blob/HEAD/docs/store.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
