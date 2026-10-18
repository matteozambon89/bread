import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose'
import { isLoopbackHostname } from '@breadai/core'
import type { AuthIdentity, BreadAuthStrategy, Principal } from '@breadai/core'

// Asymmetric only. A symmetric alg or "none" would accept a shared secret or an
// unsigned token, which a gateway assertion must not.
const ASYMMETRIC_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
] as const

const ASYMMETRIC = new Set<string>(ASYMMETRIC_ALGORITHMS)

export interface TrustedOptions {
  /** Remote JWKS URL. Required. `https`, or `http` on loopback. */
  jwksUri: string
  /** Expected `iss`. Required. One issuer. */
  issuer: string
  /** Expected `aud`. Omit to skip the audience check. An empty string throws. */
  audience?: string
  /** Header that carries the token. Default `authorization` (Bearer). */
  header?: string
  /**
   * Claim copied onto `principal.tenant`. Omit to leave `tenant` unset.
   * An empty string throws. When set, a missing, empty, or non-string claim rejects the token.
   */
  tenantClaim?: string
  /**
   * Allowed `alg` values. Defaults to RS/PS/ES and EdDSA.
   * A symmetric alg or `none` throws at construction.
   */
  algorithms?: string[]
}

/** Verify one gateway JWT against a JWKS and set `principal`. No signer. */
export function authStrategy(opts: TrustedOptions): BreadAuthStrategy {
  if (typeof opts.jwksUri !== 'string' || opts.jwksUri.length === 0) {
    throw new Error('auth-trusted: configure `jwksUri` to verify tokens')
  }
  if (typeof opts.issuer !== 'string' || opts.issuer.length === 0) {
    throw new Error('auth-trusted: configure `issuer`')
  }
  if (opts.audience === '') {
    throw new Error('auth-trusted: `audience` must be a non-empty string when set')
  }
  if (opts.tenantClaim === '') {
    throw new Error('auth-trusted: `tenantClaim` must be a non-empty string when set')
  }

  const algorithms = [...(opts.algorithms ?? ASYMMETRIC_ALGORITHMS)]
  for (const alg of algorithms) {
    if (!ASYMMETRIC.has(alg)) {
      throw new Error(
        `auth-trusted: "${alg}" is rejected — asymmetric algorithms only, never a symmetric alg or "none"`,
      )
    }
  }

  const header = (opts.header || 'authorization').toLowerCase()
  const jwks = createRemoteJWKSet(jwksUrl(opts.jwksUri))
  const issuer = opts.issuer
  const audience = opts.audience
  const tenantClaim = opts.tenantClaim
  const verifyOptions = {
    algorithms,
    issuer,
    ...(audience ? { audience } : {}),
  }

  return {
    name: 'trusted',
    async authenticate(req): Promise<AuthIdentity | null> {
      const token = bearer(req.headers.get(header))
      if (!token) return null
      try {
        const { payload } = await jwtVerify(token, jwks, verifyOptions)
        return toIdentity(payload, issuer, tenantClaim)
      } catch (err) {
        // jose throws instead of choosing when more than one key matches.
        if (!(err instanceof errors.JWKSMultipleMatchingKeys)) return null
        for await (const key of err) {
          try {
            const { payload } = await jwtVerify(token, key, verifyOptions)
            const identity = toIdentity(payload, issuer, tenantClaim)
            if (identity) return identity
          } catch {}
        }
        return null
      }
    },
  }
}

// Plain http is only safe for a loopback JWKS. Checked on URL.hostname so `[::1]` counts.
function jwksUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('auth-trusted: `jwksUri` must be https, or http on loopback')
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    return url
  }
  throw new Error('auth-trusted: `jwksUri` must be https, or http on loopback')
}

function bearer(raw: string | null): string | null {
  if (!raw) return null
  const token = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw
  return token.length > 0 ? token : null
}

function toIdentity(
  payload: JWTPayload,
  issuer: string,
  tenantClaim: string | undefined,
): AuthIdentity | null {
  const { iss, sub } = payload
  if (typeof iss !== 'string' || iss !== issuer) return null
  if (typeof sub !== 'string' || sub.length === 0) return null

  const principal: Principal = { iss, sub }
  if (tenantClaim) {
    const tenant = payload[tenantClaim]
    if (typeof tenant !== 'string' || tenant.length === 0) return null
    principal.tenant = tenant
  }

  return {
    subject: sub,
    claims: payload as Record<string, unknown>,
    principal,
  }
}
