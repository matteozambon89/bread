import { timingSafeEqual } from 'node:crypto'
import type { BreadAuthStrategy, BreadSigner, CredentialProvider } from '@breadai/core'

export interface ApiKeyOptions {
  /** Header to read/write. Default `authorization`. */
  header?: string
  /** Optional scheme prefix, e.g. `Bearer`. Omit for a raw `x-api-key`-style header. */
  scheme?: string
  /** Static set of accepted keys. */
  keys?: string[]
  /** Resolve the accepted key from a credential provider instead of (or alongside) `keys`. */
  credentials?: CredentialProvider
  /** Credential name to read the expected key from when `credentials` is set. */
  credentialName?: string
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual requires equal length; length itself is not secret here.
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function extract(raw: string | null, scheme?: string): string | null {
  if (!raw) return null
  if (!scheme) return raw
  const prefix = `${scheme} `
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : null
}

async function expectedKeys(opts: ApiKeyOptions): Promise<string[]> {
  const keys = [...(opts.keys ?? [])]
  if (opts.credentials && opts.credentialName) {
    const v = await opts.credentials.get(opts.credentialName)
    if (v) keys.push(v)
  }
  return keys
}

/** Server-side API-key verification: compares the presented key, timing-safe. */
export function authStrategy(opts: ApiKeyOptions = {}): BreadAuthStrategy {
  const header = (opts.header ?? 'authorization').toLowerCase()

  return {
    name: 'api_key',
    async authenticate(req) {
      const presented = extract(req.headers.get(header), opts.scheme)
      if (!presented) return null
      const allowed = await expectedKeys(opts)
      return allowed.some((k) => safeEqual(k, presented)) ? { subject: 'api-key' } : null
    },
  }
}

/** Client-side API-key signing: attaches the first available key. */
export function signer(opts: ApiKeyOptions = {}): BreadSigner {
  const header = (opts.header ?? 'authorization').toLowerCase()

  return {
    name: 'api_key',
    async sign(headers) {
      const [key] = await expectedKeys(opts)
      if (!key) throw new Error('auth-api-key signer: no key available to attach')
      headers.set(header, opts.scheme ? `${opts.scheme} ${key}` : key)
    },
  }
}
