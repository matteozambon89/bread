import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { v7 as uuidv7 } from 'uuid'
import type { BlobStore } from '@breadai/core'

export interface S3StoreOptions {
  bucket: string
  region?: string
  // For S3-compatible services (Cloudflare R2, MinIO, ...).
  endpoint?: string
  forcePathStyle?: boolean
  // Omit to use the AWS SDK's default credential chain (env vars, IAM role, ~/.aws/credentials).
  credentials?: { accessKeyId: string; secretAccessKey: string }
  // TTL for the presigned GET URL returned by put(). Default 3600 (1 hour).
  presignedUrlExpiresInSeconds?: number
  // Prefixed onto every generated object key. Default '' (flat bucket namespace).
  keyPrefix?: string
}

export function store(opts: S3StoreOptions): BlobStore {
  const client = new S3Client({
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.forcePathStyle !== undefined ? { forcePathStyle: opts.forcePathStyle } : {}),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  })

  return {
    async put(data, putOpts) {
      const key = `${opts.keyPrefix ?? ''}${uuidv7()}`
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          Body: data,
          ...(putOpts?.mimeType ? { ContentType: putOpts.mimeType } : {}),
        }),
      )
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: opts.bucket, Key: key }), {
        expiresIn: opts.presignedUrlExpiresInSeconds ?? 3600,
      })
      return { key, url }
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }))
        const data = await res.Body!.transformToByteArray()
        return { data, ...(res.ContentType ? { mimeType: res.ContentType } : {}) }
      } catch (err) {
        if (err instanceof NoSuchKey) return undefined
        throw err
      }
    },
  }
}
