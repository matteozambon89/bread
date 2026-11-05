import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { describe, expect, test } from 'bun:test'
import { store } from '@breadai/store-s3'

mockClient(S3Client).on(PutObjectCommand).resolves({}).on(GetObjectCommand).resolves({})

describe('s3 blob store issued urls', () => {
  test('accepts a url put returned and rejects a metadata host', async () => {
    const blob = store({
      bucket: 'test-bucket',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    })
    const { url } = await blob.put(new Uint8Array([1, 2, 3]))
    expect(await blob.issued!(url)).toBe(true)
    expect(await blob.issued!('http://169.254.169.254.nip.io/latest/meta-data')).toBe(false)
    expect(await blob.issued!('https://evil.example/clip.mp3?X-Amz-Signature=deadbeef')).toBe(false)
    const parsed = new URL(url)
    const crafted = `${parsed.origin}/other-key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef`
    expect(await blob.issued!(crafted)).toBe(true)
    expect(await blob.issued!(`${parsed.origin}/other-key`)).toBe(false)
  })
})
