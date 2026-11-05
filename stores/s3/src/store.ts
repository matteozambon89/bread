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

interface SignedOrigin {
  protocol: string
  host: string
  port: string
  pathPrefix: string
}

function signedOrigins(opts: S3StoreOptions): SignedOrigin[] {
  const prefix = opts.keyPrefix ?? ''
  if (opts.endpoint) {
    const endpoint = new URL(opts.endpoint)
    const base = {
      protocol: endpoint.protocol,
      port: endpoint.port,
      host: endpoint.hostname.toLowerCase(),
    }
    const pathStyle: SignedOrigin = { ...base, pathPrefix: `/${opts.bucket}/${prefix}` }
    if (opts.forcePathStyle) return [pathStyle]
    return [
      {
        ...base,
        host: `${opts.bucket}.${base.host}`,
        pathPrefix: prefix ? `/${prefix}` : '/',
      },
      pathStyle,
    ]
  }
  const region = opts.region ?? 'us-east-1'
  const protocol = 'https:'
  const virtual = [`${opts.bucket}.s3.${region}.amazonaws.com`, `${opts.bucket}.s3.amazonaws.com`]
  const path = [`s3.${region}.amazonaws.com`, `s3.amazonaws.com`]
  return [
    ...virtual.map((host) => ({
      protocol,
      host,
      port: '',
      pathPrefix: prefix ? `/${prefix}` : '/',
    })),
    ...path.map((host) => ({
      protocol,
      host,
      port: '',
      pathPrefix: `/${opts.bucket}/${prefix}`,
    })),
  ]
}

function presignedKey(pathname: string, pathPrefix: string): string | undefined {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (!path.startsWith(pathPrefix)) return undefined
  const key = pathPrefix === '/' ? path.slice(1) : path.slice(pathPrefix.length)
  if (key.length === 0 || key.split('/').includes('..')) return undefined
  return key
}

// put() remembers the exact URL. The same bucket and key prefix with a SigV4
// query is also issued, so a presigned URL still works in another process.
function matchesSignedUrl(opts: S3StoreOptions, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '') return false
  if (!parsed.searchParams.has('X-Amz-Algorithm') && !parsed.searchParams.has('X-Amz-Signature')) return false
  const host = parsed.hostname.toLowerCase()
  for (const origin of signedOrigins(opts)) {
    if (parsed.protocol !== origin.protocol || host !== origin.host || parsed.port !== origin.port) continue
    if (presignedKey(parsed.pathname, origin.pathPrefix) !== undefined) return true
  }
  return false
}

export function store(opts: S3StoreOptions): BlobStore {
  const client = new S3Client({
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.forcePathStyle !== undefined ? { forcePathStyle: opts.forcePathStyle } : {}),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  })
  const issuedUrls = new Set<string>()

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
      issuedUrls.add(url)
      return { key, url }
    },

    issued(url) {
      return issuedUrls.has(url) || matchesSignedUrl(opts, url)
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
