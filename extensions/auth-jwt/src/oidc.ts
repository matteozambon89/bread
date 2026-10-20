import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import type { AuthIdentity, BreadAuthStrategy, Principal } from '@breadai/core'

// No PS* and no HS*. authStrategy's JWKS default still allows PS*.
const OIDC_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
] as const

const OIDC_ALGORITHM_SET = new Set<string>(OIDC_ALGORITHMS)

const OIDC_PRESETS = ['entra', 'cognito', 'google', 'auth0', 'okta', 'keycloak'] as const

export type OidcPreset = (typeof OIDC_PRESETS)[number]

const OIDC_PRESET_SET = new Set<string>(OIDC_PRESETS)

const GOOGLE_ISSUER = 'https://accounts.google.com'
const GOOGLE_BARE_ISS = 'accounts.google.com'

export interface OidcIssuer {
  /**
   * Issuer URL. Token `iss` and the discovery document `issuer` must equal this string.
   * `google` at exactly `https://accounts.google.com` also accepts `iss` `accounts.google.com`.
   * One trailing slash is removed before `/.well-known/openid-configuration` is appended.
   */
  issuer: string
  /** Expected `aud`. */
  audience: string
  /**
   * Vendor preset. A non-empty string claim is copied to `principal.tenant`.
   * A missing or empty preset claim still authenticates, with `tenant` unset.
   * Entra copies `roles`, Cognito copies `cognito:groups`, and Keycloak copies
   * `realm_access.roles` only. Google, Auth0, and Okta copy no roles unless
   * `roleClaim` is set. A missing, empty, or non-string-array preset role claim
   * leaves `roles` unset and still authenticates.
   */
  preset?: OidcPreset
  /**
   * Claim copied onto `principal.tenant`. Overrides `preset` and is required:
   * missing or empty rejects the token.
   */
  tenantClaim?: string
  /**
   * Top-level claim copied onto `principal.roles`. Overrides the preset role
   * source, including Keycloak's nested read. A dotted name is one claim key.
   * Missing, empty, a lone string, or any value that is not a non-empty array
   * of non-empty strings rejects the token. An empty string throws at construction.
   */
  roleClaim?: string
}

export interface OidcOptions {
  /** One entry per OpenID provider. */
  issuers: OidcIssuer[]
  /** Header to read. Default `authorization` (Bearer). */
  header?: string
  /**
   * Allowed `alg` values. Defaults to RS256/384/512, ES256/384/512, and EdDSA.
   * PS*, HS*, `none`, and anything else throw at construction.
   */
  algorithms?: string[]
}

interface Discovered {
  jwks: JWTVerifyGetKey
}

/** Verify OpenID Connect tokens from configured issuers and set `principal`. No signer. */
export function oidcStrategy(opts: OidcOptions): BreadAuthStrategy {
  if (!Array.isArray(opts.issuers) || opts.issuers.length === 0) {
    throw new Error('auth-jwt: configure at least one oidc issuer')
  }

  const byIssuer = new Map<string, OidcIssuer>()
  for (const entry of opts.issuers) {
    if (!entry || typeof entry.issuer !== 'string' || entry.issuer.length === 0) {
      throw new Error('auth-jwt: oidc issuer must not be empty')
    }
    if (typeof entry.audience !== 'string' || entry.audience.length === 0) {
      throw new Error('auth-jwt: oidc audience must not be empty')
    }
    if (!isAllowedUrl(entry.issuer)) {
      throw new Error(
        'auth-jwt: oidc issuer must be https, or http://localhost or http://127.0.0.1',
      )
    }
    if (byIssuer.has(entry.issuer)) {
      throw new Error(`auth-jwt: duplicate oidc issuer "${entry.issuer}"`)
    }
    if (entry.preset !== undefined && !OIDC_PRESET_SET.has(entry.preset)) {
      throw new Error(`auth-jwt: unknown oidc preset "${entry.preset}"`)
    }
    if (
      entry.roleClaim !== undefined &&
      (typeof entry.roleClaim !== 'string' || entry.roleClaim.length === 0)
    ) {
      throw new Error('auth-jwt: oidc roleClaim must not be empty')
    }
    byIssuer.set(entry.issuer, entry)
  }

  const algorithms = [...(opts.algorithms ?? OIDC_ALGORITHMS)]
  for (const alg of algorithms) {
    if (!OIDC_ALGORITHM_SET.has(alg)) {
      throw new Error(
        `auth-jwt: "${alg}" is rejected — oidc allows only RS256, RS384, RS512, ES256, ES384, ES512, and EdDSA`,
      )
    }
  }

  const header = (opts.header ?? 'authorization').toLowerCase()
  const cache = new Map<string, Promise<Discovered | null>>()

  return {
    name: 'oidc',
    async authenticate(req): Promise<AuthIdentity | null> {
      const token = bearer(req.headers.get(header))
      if (!token) return null
      // Unverified iss only picks a configured entry. Discovery is not fetched otherwise.
      const iss = unverifiedIssuer(token)
      if (!iss) return null
      const entry = configuredIssuer(byIssuer, iss)
      if (!entry) return null
      const discovered = await discover(cache, entry.issuer)
      if (!discovered) return null
      try {
        const { payload } = await jwtVerify(token, discovered.jwks, {
          algorithms,
          issuer: verifyIssuers(entry),
          audience: entry.audience,
        })
        return toIdentity(payload, entry)
      } catch {
        return null
      }
    },
  }
}

function unverifiedIssuer(token: string): string | null {
  try {
    const payload = decodeJwt(token)
    return typeof payload.iss === 'string' && payload.iss.length > 0 ? payload.iss : null
  } catch {
    return null
  }
}

// A failed fetch is not stored, so a later request can retry. A good document stays with the strategy.
function discover(
  cache: Map<string, Promise<Discovered | null>>,
  issuer: string,
): Promise<Discovered | null> {
  const cached = cache.get(issuer)
  if (cached) return cached
  const pending = fetchDiscovery(issuer).then((found) => {
    if (!found) cache.delete(issuer)
    return found
  })
  cache.set(issuer, pending)
  return pending
}

async function fetchDiscovery(issuer: string): Promise<Discovered | null> {
  try {
    // A redirect could move discovery onto another host.
    const response = await fetch(discoveryUrl(issuer), {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const document: unknown = await response.json()
    if (!document || typeof document !== 'object') return null
    const body = document as { issuer?: unknown; jwks_uri?: unknown }
    if (body.issuer !== issuer) return null
    if (typeof body.jwks_uri !== 'string' || !isAllowedUrl(body.jwks_uri)) return null
    return { jwks: createRemoteJWKSet(new URL(body.jwks_uri)) }
  } catch {
    return null
  }
}

// One trailing slash, so an issuer that already has a path still resolves.
function discoveryUrl(issuer: string): string {
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer
  return `${base}/.well-known/openid-configuration`
}

// https anywhere, or http on localhost / 127.0.0.1. The host need not match the issuer.
function isAllowedUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

function bearer(raw: string | null): string | null {
  if (!raw) return null
  const token = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw
  return token.length > 0 ? token : null
}

function presetClaim(preset: OidcPreset): string | undefined {
  switch (preset) {
    case 'entra':
      return 'tid'
    case 'cognito':
      return 'custom:tenant'
    case 'google':
      return 'hd'
    case 'auth0':
      return 'org_id'
    case 'okta':
    case 'keycloak':
      return undefined
    default: {
      const unknown: never = preset
      throw new Error(`auth-jwt: unknown oidc preset "${String(unknown)}"`)
    }
  }
}

// A preset claim that is missing or empty leaves tenant unset. An explicit tenantClaim is required.
function readTenant(payload: JWTPayload, entry: OidcIssuer): string | null | undefined {
  if (entry.tenantClaim !== undefined) return nonEmpty(payload[entry.tenantClaim]) ?? null
  if (entry.preset === undefined) return undefined
  const claim = presetClaim(entry.preset)
  if (claim === undefined) return undefined
  return nonEmpty(payload[claim])
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Preset miss omits roles. An explicit roleClaim that fails returns null.
function readRoles(payload: JWTPayload, entry: OidcIssuer): string[] | null | undefined {
  if (entry.roleClaim !== undefined) return requiredRoles(payload[entry.roleClaim])
  if (entry.preset === undefined) return undefined
  return presetRoles(entry.preset, payload)
}

function presetRoles(preset: OidcPreset, payload: JWTPayload): string[] | undefined {
  switch (preset) {
    case 'entra':
      return issuedStringArray(payload.roles)
    case 'cognito':
      return issuedStringArray(payload['cognito:groups'])
    case 'google':
    case 'auth0':
    case 'okta':
      return undefined
    case 'keycloak':
      return keycloakRealmRoles(payload.realm_access)
    default: {
      const unknown: never = preset
      throw new Error(`auth-jwt: unknown oidc preset "${String(unknown)}"`)
    }
  }
}

function keycloakRealmRoles(realmAccess: unknown): string[] | undefined {
  if (!realmAccess || typeof realmAccess !== 'object' || Array.isArray(realmAccess)) {
    return undefined
  }
  return issuedStringArray((realmAccess as { roles?: unknown }).roles)
}

// Empty and non-string arrays are a preset miss. Values are copied, not normalized.
function issuedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const roles: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    roles.push(item)
  }
  return roles
}

// roleClaim does not wrap a lone string and does not accept an empty string element.
function requiredRoles(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const roles: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return null
    roles.push(item)
  }
  return roles
}

function acceptsGoogleBareIss(entry: OidcIssuer): boolean {
  return entry.preset === 'google' && entry.issuer === GOOGLE_ISSUER
}

function verifyIssuers(entry: OidcIssuer): string | string[] {
  if (acceptsGoogleBareIss(entry)) return [GOOGLE_ISSUER, GOOGLE_BARE_ISS]
  return entry.issuer
}

function configuredIssuer(
  byIssuer: Map<string, OidcIssuer>,
  iss: string,
): OidcIssuer | undefined {
  const direct = byIssuer.get(iss)
  if (direct) return direct
  if (iss !== GOOGLE_BARE_ISS) return undefined
  const entry = byIssuer.get(GOOGLE_ISSUER)
  if (entry && acceptsGoogleBareIss(entry)) return entry
  return undefined
}

function issuerAccepted(iss: string, entry: OidcIssuer): boolean {
  const accepted = verifyIssuers(entry)
  return typeof accepted === 'string' ? iss === accepted : accepted.includes(iss)
}

function toIdentity(payload: JWTPayload, entry: OidcIssuer): AuthIdentity | null {
  const iss = payload.iss
  const sub = payload.sub
  if (typeof iss !== 'string' || iss.length === 0 || !issuerAccepted(iss, entry)) return null
  if (typeof sub !== 'string' || sub.length === 0) return null
  const tenant = readTenant(payload, entry)
  if (tenant === null) return null
  const roles = readRoles(payload, entry)
  if (roles === null) return null
  const principal: Principal = { iss, sub }
  if (tenant !== undefined) principal.tenant = tenant
  if (roles !== undefined) principal.roles = roles
  return { subject: sub, claims: payload as Record<string, unknown>, principal }
}
