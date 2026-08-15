import { type JWTPayload, type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose'
import type { BreadAuthStrategy } from '@breadai/core'

// Default allowlist for asymmetric (JWKS) mode — the common RS/PS/ES families. Overridable via
// `algorithms`; a caller using a narrower key set should pin it explicitly.
const DEFAULT_ASYMMETRIC_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
]

export interface JwtOptions {
  /** HS256 symmetric secret. */
  secret?: string
  /** Remote JWKS URL for asymmetric (RS/ES) verification. */
  jwksUri?: string
  issuer?: string
  audience?: string
  /** Header to read. Default `authorization` (Bearer). */
  header?: string
  /**
   * Allowed `alg` values. Defaults to `['HS256']` for `secret` mode, or the common RS/PS/ES set
   * for `jwksUri` mode — override to pin a narrower set.
   */
  algorithms?: string[]
  /**
   * Both `issuer` and `audience` unset means no claim-based scoping is enforced beyond
   * signature+expiry — `authStrategy()` throws unless this is explicitly acknowledged.
   */
  allowUnverifiedIssuerAudience?: boolean
}

/** JWT bearer-token verification via `jose` (symmetric secret or remote JWKS). */
export function authStrategy(opts: JwtOptions = {}): BreadAuthStrategy {
  const header = (opts.header ?? 'authorization').toLowerCase()
  const jwks: JWTVerifyGetKey | null = opts.jwksUri
    ? createRemoteJWKSet(new URL(opts.jwksUri))
    : null
  const secret = opts.secret ? new TextEncoder().encode(opts.secret) : null

  if (!jwks && !secret) {
    throw new Error('auth-jwt: configure `secret` or `jwksUri` to verify tokens')
  }
  if (!opts.issuer && !opts.audience && !opts.allowUnverifiedIssuerAudience) {
    throw new Error(
      'auth-jwt: configure `issuer` and/or `audience`, or pass `allowUnverifiedIssuerAudience: true` ' +
        'to explicitly accept signature+expiry-only verification',
    )
  }

  const algorithms = opts.algorithms ?? (secret ? ['HS256'] : DEFAULT_ASYMMETRIC_ALGORITHMS)

  return {
    name: 'jwt',
    async authenticate(req) {
      const raw = req.headers.get(header)
      const token = raw?.startsWith('Bearer ') ? raw.slice(7) : raw
      if (!token) return null
      try {
        const options = {
          algorithms,
          ...(opts.issuer ? { issuer: opts.issuer } : {}),
          ...(opts.audience ? { audience: opts.audience } : {}),
        }
        const { payload } = jwks
          ? await jwtVerify(token, jwks, options)
          : await jwtVerify(token, secret!, options)
        const p = payload as JWTPayload
        return { subject: String(p.sub ?? 'jwt'), claims: payload as Record<string, unknown> }
      } catch {
        return null
      }
    },
  }
}
