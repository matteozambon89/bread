import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SignJWT, type KeyLike, exportJWK, generateKeyPair } from 'jose'
import { authStrategy } from '@bread/auth-jwt'

const SECRET = 'super-secret-signing-key'

function reqWith(headers: Record<string, string>): Request {
  return new Request('http://x/agents', { headers })
}

// Mint an HS256 token signed with the shared SECRET.
async function hs256(
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
  if (opts.issuer) builder = builder.setIssuer(opts.issuer)
  if (opts.audience) builder = builder.setAudience(opts.audience)
  if (opts.expiresIn) builder = builder.setExpirationTime(opts.expiresIn)
  return builder.sign(new TextEncoder().encode(SECRET))
}

describe('jwt auth strategy — HS256', () => {
  test('accepts a valid token and exposes its subject and claims', async () => {
    const strat = authStrategy({ secret: SECRET, allowUnverifiedIssuerAudience: true })
    const token = await hs256({ sub: 'user-42', role: 'admin' })
    const identity = await strat.authenticate(reqWith({ authorization: `Bearer ${token}` }))
    expect(identity).toMatchObject({ subject: 'user-42' })
    expect((identity!.claims as Record<string, unknown>).role).toBe('admin')
  })

  test('verifies a raw token without the Bearer scheme prefix', async () => {
    const strat = authStrategy({ secret: SECRET, allowUnverifiedIssuerAudience: true })
    const token = await hs256({ sub: 'raw' })
    expect(await strat.authenticate(reqWith({ authorization: token }))).toMatchObject({
      subject: 'raw',
    })
  })

  test('falls back to "jwt" when the token carries no subject', async () => {
    const strat = authStrategy({ secret: SECRET, allowUnverifiedIssuerAudience: true })
    const token = await hs256({ role: 'anon' })
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${token}` }))).toMatchObject({
      subject: 'jwt',
    })
  })

  test('rejects a token signed with a different secret', async () => {
    const token = await hs256({ sub: 'user' })
    const strat = authStrategy({
      secret: 'a-completely-different-secret',
      allowUnverifiedIssuerAudience: true,
    })
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${token}` }))).toBeNull()
  })

  test('rejects an expired token', async () => {
    const strat = authStrategy({ secret: SECRET, allowUnverifiedIssuerAudience: true })
    const token = await new SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(0)
      .setExpirationTime(1) // 1 second after the epoch — long past
      .sign(new TextEncoder().encode(SECRET))
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${token}` }))).toBeNull()
  })

  test('rejects a missing header', async () => {
    const strat = authStrategy({ secret: SECRET, allowUnverifiedIssuerAudience: true })
    expect(await strat.authenticate(reqWith({}))).toBeNull()
  })

  test('enforces the configured issuer', async () => {
    const strat = authStrategy({ secret: SECRET, issuer: 'https://issuer.example' })
    const good = await hs256({ sub: 'u' }, { issuer: 'https://issuer.example' })
    const bad = await hs256({ sub: 'u' }, { issuer: 'https://evil.example' })
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${good}` }))).toMatchObject({
      subject: 'u',
    })
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${bad}` }))).toBeNull()
  })

  test('enforces the configured audience', async () => {
    const strat = authStrategy({ secret: SECRET, audience: 'bread-api' })
    const good = await hs256({ sub: 'u' }, { audience: 'bread-api' })
    const bad = await hs256({ sub: 'u' }, { audience: 'other-api' })
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${good}` }))).toMatchObject({
      subject: 'u',
    })
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${bad}` }))).toBeNull()
  })

  test('reads the token from a custom header', async () => {
    const strat = authStrategy({
      secret: SECRET,
      header: 'x-access-token',
      allowUnverifiedIssuerAudience: true,
    })
    const token = await hs256({ sub: 'custom' })
    expect(
      await strat.authenticate(reqWith({ 'x-access-token': `Bearer ${token}` })),
    ).toMatchObject({ subject: 'custom' })
  })

  test('throws at construction when neither secret nor jwksUri is configured', () => {
    expect(() => authStrategy({})).toThrow(/configure `secret` or `jwksUri`/)
  })

  test('throws at construction when neither issuer nor audience is configured, without the opt-out', () => {
    expect(() => authStrategy({ secret: SECRET })).toThrow(/allowUnverifiedIssuerAudience/)
  })

  test('does not throw when the issuer/audience opt-out is explicitly set', () => {
    expect(() =>
      authStrategy({ secret: SECRET, allowUnverifiedIssuerAudience: true }),
    ).not.toThrow()
  })

  test('rejects a token signed with an algorithm outside the default allowlist', async () => {
    const strat = authStrategy({ secret: SECRET, allowUnverifiedIssuerAudience: true })
    const token = await new SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'HS384' })
      .setIssuedAt()
      .sign(new TextEncoder().encode(SECRET))
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${token}` }))).toBeNull()
  })
})

describe('jwt auth strategy — JWKS (asymmetric)', () => {
  let privateKey: KeyLike
  let server: ReturnType<typeof Bun.serve>
  let jwksUri: string

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256')
    privateKey = pair.privateKey
    const jwk = await exportJWK(pair.publicKey)
    jwk.kid = 'test-key'
    jwk.alg = 'RS256'
    jwk.use = 'sig'
    server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys: [jwk] }),
    })
    jwksUri = `http://localhost:${server.port}/.well-known/jwks.json`
  })

  afterAll(() => server.stop(true))

  test('verifies a token against keys fetched from the JWKS endpoint', async () => {
    const strat = authStrategy({ jwksUri, allowUnverifiedIssuerAudience: true })
    const token = await new SignJWT({ sub: 'rsa-user' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .sign(privateKey)
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${token}` }))).toMatchObject({
      subject: 'rsa-user',
    })
  })

  test('rejects a token whose key is not in the JWKS', async () => {
    const strat = authStrategy({ jwksUri, allowUnverifiedIssuerAudience: true })
    const other = await generateKeyPair('RS256')
    const token = await new SignJWT({ sub: 'impostor' })
      .setProtectedHeader({ alg: 'RS256', kid: 'unknown-key' })
      .setIssuedAt()
      .sign(other.privateKey)
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${token}` }))).toBeNull()
  })
})
