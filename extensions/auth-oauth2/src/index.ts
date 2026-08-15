import type { BreadAuthStrategy, BreadSigner } from '@bread/core'
import { authStrategy as jwtAuthStrategy } from '@bread/auth-jwt'

export interface VerifyOptions {
  /** HS256 symmetric secret. */
  secret?: string
  /** Remote JWKS URL for asymmetric (RS/ES) verification. */
  jwksUri?: string
  issuer?: string
  audience?: string
  /** Header to read. Default `authorization` (Bearer). */
  header?: string
  /** Mirrors `@bread/auth-jwt`'s `JwtOptions.algorithms` — see there for the default. */
  algorithms?: string[]
  /** Mirrors `@bread/auth-jwt`'s `JwtOptions.allowUnverifiedIssuerAudience`. */
  allowUnverifiedIssuerAudience?: boolean
}

export interface ClientCredentialsOptions {
  tokenUrl: string
  clientId: string
  clientSecret: string
  scope?: string
  /** Header to write. Default `authorization` (Bearer). */
  header?: string
}

/**
 * OAuth 2.0 bearer-token verification (the MCP standard for HTTP transports):
 * validates an incoming access token as a JWT, reusing `@bread/auth-jwt`.
 */
export function authStrategy(opts: VerifyOptions): BreadAuthStrategy {
  const jwtStrategy = jwtAuthStrategy(opts)
  return { name: 'oauth2', authenticate: (req) => jwtStrategy.authenticate(req) }
}

/** OAuth 2.0 client-credentials grant, with token caching. */
export function signer(opts: ClientCredentialsOptions): BreadSigner {
  const header = (opts.header ?? 'authorization').toLowerCase()
  let cached: { token: string; expiresAt: number } | null = null

  async function fetchToken(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 5000) return cached.token

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    })
    if (opts.scope) body.set('scope', opts.scope)

    const res = await fetch(opts.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) {
      throw new Error(`oauth2 token request failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number }
    cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 }
    return cached.token
  }

  return {
    name: 'oauth2',
    async sign(headers) {
      headers.set(header, `Bearer ${await fetchToken()}`)
    },
  }
}
