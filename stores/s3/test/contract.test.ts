import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { store } from '@bread/store-s3'
import { runBlobContract } from '@bread/test-utils'

// aws-sdk-client-mock patches S3Client.prototype.send, so any client store()
// constructs is automatically intercepted — no client injection needed.
// getSignedUrl() does local SigV4 signing (no network call), so it works
// against the mocked client unmodified.
const s3Mock = mockClient(S3Client)
const objects = new Map<string, { data: Uint8Array; mimeType?: string }>()

s3Mock.on(PutObjectCommand).callsFake(async (input) => {
  objects.set(input.Key, { data: input.Body, mimeType: input.ContentType })
  return {}
})
s3Mock.on(GetObjectCommand).callsFake(async (input) => {
  const obj = objects.get(input.Key)
  if (!obj) {
    throw new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} })
  }
  return { Body: { transformToByteArray: async () => obj.data }, ContentType: obj.mimeType }
})

// getSignedUrl() computes a SigV4 signature locally (no network call) but
// still needs *some* credentials to sign with — explicit fake ones here
// avoid hitting the real AWS credential-resolution chain in tests.
runBlobContract('s3', () =>
  store({
    bucket: 'test-bucket',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  }),
)
