import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SignJWT, type KeyLike, exportJWK, generateKeyPair } from 'jose'
import { authStrategy, mtlsStrategy, type MtlsOptions, type TrustedOptions } from '@breadai/auth-trusted'
import { attachVerifiedPeer, type VerifiedPeerCertificate } from '@breadai/core'

const ISSUER = 'https://gateway.example'
const AUDIENCE = 'bread'

function reqWith(headers: Record<string, string>): Request {
  return new Request('http://x/agents', { headers })
}

describe('trusted auth strategy', () => {
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

  function strategy(overrides: Partial<TrustedOptions> = {}) {
    return authStrategy({ jwksUri, issuer: ISSUER, ...overrides } as TrustedOptions)
  }

  async function sign(
    claims: Record<string, unknown>,
    opts: { issuer?: string; audience?: string; key?: KeyLike; kid?: string } = {},
  ): Promise<string> {
    let builder = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'test-key' })
      .setIssuedAt()
      .setExpirationTime('2m')
    builder = builder.setIssuer(opts.issuer ?? ISSUER)
    if (opts.audience) builder = builder.setAudience(opts.audience)
    return builder.sign(opts.key ?? privateKey)
  }

  function authed(token: string, extra: Record<string, string> = {}): Request {
    return reqWith({ authorization: `Bearer ${token}`, ...extra })
  }

  test('a verified token sets subject, claims, and principal with iss and sub', async () => {
    const token = await sign({ sub: 'user-1', role: 'admin' })
    const identity = await strategy().authenticate(authed(token))
    expect(identity?.subject).toBe('user-1')
    expect(identity?.claims).toMatchObject({ sub: 'user-1', iss: ISSUER, role: 'admin' })
    expect(identity?.principal).toEqual({ iss: ISSUER, sub: 'user-1' })
    expect(identity?.principal).not.toHaveProperty('tenant')
    expect(strategy().name).toBe('trusted')
  })

  test('an EdDSA token verifies with the default algorithms', async () => {
    const pair = await generateKeyPair('EdDSA')
    const jwk = await exportJWK(pair.publicKey)
    jwk.kid = 'ed-key'
    jwk.alg = 'EdDSA'
    jwk.use = 'sig'
    const edServer = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys: [jwk] }),
    })
    try {
      const strat = authStrategy({
        jwksUri: `http://localhost:${edServer.port}/.well-known/jwks.json`,
        issuer: ISSUER,
      })
      const token = await new SignJWT({ sub: 'ed-user' })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'ed-key' })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(pair.privateKey)
      const identity = await strat.authenticate(authed(token))
      expect(identity?.principal).toEqual({ iss: ISSUER, sub: 'ed-user' })
    } finally {
      edServer.stop(true)
    }
  })

  test('a configured tenant claim is copied onto principal.tenant', async () => {
    const token = await sign({ sub: 'user-1', tenant: 'acme' })
    const identity = await strategy({ tenantClaim: 'tenant' }).authenticate(authed(token))
    expect(identity?.principal).toEqual({ iss: ISSUER, sub: 'user-1', tenant: 'acme' })
  })

  test('an omitted tenantClaim leaves tenant unset', async () => {
    const token = await sign({ sub: 'user-1', tenant: 'acme' })
    const identity = await strategy().authenticate(authed(token))
    expect(identity?.principal).toEqual({ iss: ISSUER, sub: 'user-1' })
    expect(identity?.principal).not.toHaveProperty('tenant')
  })

  test('a missing token header returns null', async () => {
    expect(await strategy().authenticate(reqWith({}))).toBeNull()
  })

  test('an unsigned identity header alone returns null', async () => {
    const identity = await strategy({ tenantClaim: 'tenant' }).authenticate(
      reqWith({
        'x-user-id': 'user-1',
        'x-forwarded-user': 'user-1',
        'x-forwarded-email': 'user@evil.example',
      }),
    )
    expect(identity).toBeNull()
  })

  test('an unsigned identity header does not override sub or tenant on a valid token', async () => {
    const token = await sign({ sub: 'user-1', tenant: 'acme' })
    const identity = await strategy({ tenantClaim: 'tenant' }).authenticate(
      authed(token, {
        'x-user-id': 'spoof',
        'x-forwarded-user': 'spoof',
        'x-forwarded-email': 'spoof@evil.example',
      }),
    )
    expect(identity?.subject).toBe('user-1')
    expect(identity?.principal).toEqual({ iss: ISSUER, sub: 'user-1', tenant: 'acme' })
  })

  test('a token with no sub returns null', async () => {
    const token = await sign({ role: 'anon' })
    expect(await strategy().authenticate(authed(token))).toBeNull()
  })

  test('a token with an empty sub returns null', async () => {
    const token = await sign({ sub: '' })
    expect(await strategy().authenticate(authed(token))).toBeNull()
  })

  test('a non-string sub returns null', async () => {
    const token = await sign({ sub: 42 })
    expect(await strategy().authenticate(authed(token))).toBeNull()
  })

  test('a token whose iss is not the configured issuer returns null', async () => {
    const token = await sign({ sub: 'user-1' }, { issuer: 'https://evil.example' })
    expect(await strategy().authenticate(authed(token))).toBeNull()
  })

  test('a failed audience check returns null', async () => {
    const strat = strategy({ audience: AUDIENCE })
    const bad = await sign({ sub: 'user-1' }, { audience: 'other' })
    const missing = await sign({ sub: 'user-1' })
    expect(await strat.authenticate(authed(bad))).toBeNull()
    expect(await strat.authenticate(authed(missing))).toBeNull()
  })

  test('a bad signature returns null', async () => {
    const other = await generateKeyPair('RS256')
    const token = await sign({ sub: 'user-1' }, { key: other.privateKey })
    expect(await strategy().authenticate(authed(token))).toBeNull()
  })

  test('a symmetric alg in algorithms throws at construction', () => {
    expect(() => strategy({ algorithms: ['HS256'] })).toThrow(/symmetric/)
    expect(() => strategy({ algorithms: ['RS256', 'HS384'] })).toThrow(/symmetric/)
  })

  test('none in algorithms throws at construction', () => {
    expect(() => strategy({ algorithms: ['none'] })).toThrow(/none/)
    expect(() => strategy({ algorithms: ['RS256', 'none'] })).toThrow(/none/)
  })

  test('a missing jwksUri or issuer throws at construction', () => {
    expect(() => authStrategy({ issuer: ISSUER } as TrustedOptions)).toThrow(/jwksUri/)
    expect(() => authStrategy({ jwksUri } as TrustedOptions)).toThrow(/issuer/)
    expect(() => authStrategy({ jwksUri: '', issuer: ISSUER })).toThrow(/jwksUri/)
    expect(() => authStrategy({ jwksUri, issuer: '' })).toThrow(/issuer/)
  })

  test('a configured tenant claim that is empty returns null', async () => {
    const token = await sign({ sub: 'user-1', tenant: '' })
    expect(await strategy({ tenantClaim: 'tenant' }).authenticate(authed(token))).toBeNull()
  })

  test('a configured tenant claim that is missing returns null', async () => {
    const token = await sign({ sub: 'user-1' })
    expect(await strategy({ tenantClaim: 'tenant' }).authenticate(authed(token))).toBeNull()
  })

  test('a configured tenant claim that is not a string returns null', async () => {
    const token = await sign({ sub: 'user-1', tenant: 42 })
    expect(await strategy({ tenantClaim: 'tenant' }).authenticate(authed(token))).toBeNull()
  })

  test('reads the token from the configured header only', async () => {
    const strat = strategy({ header: 'x-access-token' })
    const token = await sign({ sub: 'user-1' })
    expect(
      await strat.authenticate(reqWith({ 'x-access-token': `Bearer ${token}` })),
    ).toMatchObject({ subject: 'user-1', principal: { iss: ISSUER, sub: 'user-1' } })
    expect(await strat.authenticate(authed(token))).toBeNull()
  })

  test('an empty audience throws at construction', () => {
    expect(() => strategy({ audience: '' })).toThrow(/audience/)
  })

  test('an empty tenantClaim throws at construction', () => {
    expect(() => strategy({ tenantClaim: '' })).toThrow(/tenantClaim/)
  })

  test('http://gateway.example is rejected at construction', () => {
    expect(() => authStrategy({ jwksUri: 'http://gateway.example', issuer: ISSUER })).toThrow(/https/)
  })

  test('https://gateway.example is accepted at construction', () => {
    expect(() => authStrategy({ jwksUri: 'https://gateway.example', issuer: ISSUER })).not.toThrow()
  })

  test('http on loopback is accepted, and another scheme or an unparseable URL throws', () => {
    expect(() => authStrategy({ jwksUri: 'http://localhost/jwks', issuer: ISSUER })).not.toThrow()
    expect(() => authStrategy({ jwksUri: 'http://127.0.0.1/jwks', issuer: ISSUER })).not.toThrow()
    expect(() => authStrategy({ jwksUri: 'http://[::1]/jwks', issuer: ISSUER })).not.toThrow()
    expect(() => authStrategy({ jwksUri: 'ftp://localhost/jwks', issuer: ISSUER })).toThrow(/https/)
    expect(() => authStrategy({ jwksUri: 'not a url', issuer: ISSUER })).toThrow(/jwksUri/)
  })

  async function serveTwoRs256Keys(): Promise<{
    jwksUri: string
    second: KeyLike
    stop: () => void
  }> {
    const first = await generateKeyPair('RS256')
    const second = await generateKeyPair('RS256')
    const keys = []
    for (const [pair, kid] of [
      [first, 'key-a'],
      [second, 'key-b'],
    ] as const) {
      const jwk = await exportJWK(pair.publicKey)
      jwk.kid = kid
      jwk.alg = 'RS256'
      jwk.use = 'sig'
      keys.push(jwk)
    }
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys }),
    })
    return {
      jwksUri: `http://localhost:${server.port}/.well-known/jwks.json`,
      second: second.privateKey,
      stop: () => server.stop(true),
    }
  }

  function signKidless(key: KeyLike): Promise<string> {
    return new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(key)
  }

  test('a kid-less token verifies when one of two RS256 JWKS keys signed it', async () => {
    const served = await serveTwoRs256Keys()
    try {
      const strat = authStrategy({ jwksUri: served.jwksUri, issuer: ISSUER })
      const token = await signKidless(served.second)
      const identity = await strat.authenticate(authed(token))
      expect(identity?.principal).toEqual({ iss: ISSUER, sub: 'user-1' })
    } finally {
      served.stop()
    }
  })

  test('a kid-less token signed by neither of two RS256 JWKS keys returns null', async () => {
    const served = await serveTwoRs256Keys()
    try {
      const other = await generateKeyPair('RS256')
      const strat = authStrategy({ jwksUri: served.jwksUri, issuer: ISSUER })
      const token = await signKidless(other.privateKey)
      expect(await strat.authenticate(authed(token))).toBeNull()
    } finally {
      served.stop()
    }
  })
})

const SPOOF_HEADERS = {
  'x-user-id': 'spoof',
  'x-forwarded-user': 'spoof',
  'x-forwarded-email': 'spoof@evil.example',
  'ssl-client-cert': 'spoof',
  'x-forwarded-client-cert': 'spoof',
}

function peer(overrides: Partial<VerifiedPeerCertificate> = {}): VerifiedPeerCertificate {
  return {
    subjectCn: 'user-1',
    issuerCn: 'gateway-ca',
    fingerprint256: 'AA:BB',
    organizationalUnits: [],
    ...overrides,
  }
}

function requestWith(peerCert: VerifiedPeerCertificate | undefined, headers: Record<string, string> = {}): Request {
  const req = new Request('https://bread.example/agents', { headers })
  if (peerCert) attachVerifiedPeer(req, peerCert)
  return req
}

describe('mtls auth strategy', () => {
  test('a verified leaf sets subject, principal, and fingerprint256', async () => {
    const strategy = mtlsStrategy({ issuer: 'gateway-ca' })
    const req = requestWith(peer({ organizationalUnits: ['acme'] }))
    const identity = await strategy.authenticate(req)
    expect(strategy.name).toBe('trusted-mtls')
    expect(identity).toEqual({
      subject: 'user-1',
      claims: { iss: 'gateway-ca', sub: 'user-1', fingerprint256: 'AA:BB' },
      principal: { iss: 'gateway-ca', sub: 'user-1' },
    })
    expect(identity?.principal).not.toHaveProperty('tenant')
    expect(strategy).not.toHaveProperty('middleware')
  })

  test('tenantField ou copies one OU and omitting it leaves tenant unset', async () => {
    const leaf = peer({ organizationalUnits: ['acme'] })
    const withTenant = await mtlsStrategy({ issuer: 'gateway-ca', tenantField: 'ou' }).authenticate(requestWith(leaf))
    expect(withTenant?.principal).toEqual({ iss: 'gateway-ca', sub: 'user-1', tenant: 'acme' })
    const without = await mtlsStrategy({ issuer: 'gateway-ca' }).authenticate(requestWith(leaf))
    expect(without?.principal).toEqual({ iss: 'gateway-ca', sub: 'user-1' })
    expect(without?.principal).not.toHaveProperty('tenant')
  })

  test('a missing, empty, or multi-value OU returns null when tenantField is ou', async () => {
    const strategy = mtlsStrategy({ issuer: 'gateway-ca', tenantField: 'ou' })
    expect(await strategy.authenticate(requestWith(peer()))).toBeNull()
    expect(await strategy.authenticate(requestWith(peer({ organizationalUnits: [''] })))).toBeNull()
    expect(await strategy.authenticate(requestWith(peer({ organizationalUnits: ['acme', 'other'] })))).toBeNull()
  })

  test('no peer, an issuer mismatch, or an empty CN returns null', async () => {
    const strategy = mtlsStrategy({ issuer: 'gateway-ca', tenantField: 'ou' })
    expect(await strategy.authenticate(requestWith(undefined))).toBeNull()
    expect(await strategy.authenticate(requestWith(peer({ issuerCn: 'other-ca', organizationalUnits: ['acme'] })))).toBeNull()
    expect(await strategy.authenticate(requestWith(peer({ subjectCn: '' })))).toBeNull()
    expect(await strategy.authenticate(requestWith(peer({ issuerCn: '' })))).toBeNull()
  })

  test('forwarded identity and cert headers are not read and are not deleted', async () => {
    const strategy = mtlsStrategy({ issuer: 'gateway-ca', tenantField: 'ou' })
    const alone = requestWith(undefined, SPOOF_HEADERS)
    expect(await strategy.authenticate(alone)).toBeNull()
    for (const [name, value] of Object.entries(SPOOF_HEADERS)) expect(alone.headers.get(name)).toBe(value)

    const authed = requestWith(peer({ organizationalUnits: ['acme'] }), SPOOF_HEADERS)
    const identity = await strategy.authenticate(authed)
    expect(identity?.principal).toEqual({ iss: 'gateway-ca', sub: 'user-1', tenant: 'acme' })
    expect(identity?.subject).toBe('user-1')
    for (const [name, value] of Object.entries(SPOOF_HEADERS)) expect(authed.headers.get(name)).toBe(value)
  })

  test('an empty issuer or tenantField, or any tenantField other than ou, throws', () => {
    expect(() => mtlsStrategy({ issuer: '' })).toThrow(/issuer/)
    expect(() => mtlsStrategy({} as MtlsOptions)).toThrow(/issuer/)
    expect(() => mtlsStrategy({ issuer: 'gateway-ca', tenantField: '' as 'ou' })).toThrow(/tenantField/)
    expect(() => mtlsStrategy({ issuer: 'gateway-ca', tenantField: 'tenant' as 'ou' })).toThrow(/tenantField/)
    expect(() => mtlsStrategy({ issuer: 'gateway-ca', tenantField: 'OU' as 'ou' })).toThrow(/tenantField/)
  })
})
