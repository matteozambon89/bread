import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SignJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload, type KeyLike } from 'jose'
import { oidcStrategy, type OidcIssuer, type OidcPreset } from '@breadai/auth-jwt'

const AUDIENCE = 'bread-api'

function reqWith(headers: Record<string, string>): Request {
  return new Request('http://x/agents', { headers })
}

function authed(token: string): Request {
  return reqWith({ authorization: `Bearer ${token}` })
}

interface MintedKey {
  kid: string
  privateKey: KeyLike
  jwk: JWK
}

async function mintedKey(kid: string): Promise<MintedKey> {
  const pair = await generateKeyPair('RS256')
  const jwk = await exportJWK(pair.publicKey)
  jwk.kid = kid
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  return { kid, privateKey: pair.privateKey, jwk }
}

interface IssuerServer {
  issuer: string
  server: ReturnType<typeof Bun.serve>
  keys: MintedKey[]
}

const servers: ReturnType<typeof Bun.serve>[] = []

function track(server: ReturnType<typeof Bun.serve>): ReturnType<typeof Bun.serve> {
  servers.push(server)
  return server
}

async function startIssuer(opts: {
  keys?: MintedKey[]
  documentIssuer?: string
  jwksUri?: string
  trailingSlash?: boolean
} = {}): Promise<IssuerServer> {
  const keys = opts.keys && opts.keys.length > 0 ? opts.keys : [await mintedKey('test-key')]
  let advertised = ''
  let jwksUri = ''
  const server = track(Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/.well-known/openid-configuration') {
        return Response.json({ issuer: advertised, jwks_uri: jwksUri })
      }
      if (path === '/jwks') return Response.json({ keys: keys.map((key) => key.jwk) })
      return new Response(null, { status: 404 })
    },
  }))
  const origin = `http://127.0.0.1:${server.port}`
  const issuer = opts.trailingSlash ? `${origin}/` : origin
  advertised = opts.documentIssuer ?? issuer
  jwksUri = opts.jwksUri ?? `${origin}/jwks`
  return { issuer, server, keys }
}

function firstKey(server: IssuerServer): MintedKey {
  const key = server.keys[0]
  if (!key) throw new Error('oidc test issuer has no signing key')
  return key
}

async function signToken(opts: {
  privateKey: KeyLike
  issuer: string
  kid?: string
  sub?: string
  audience?: string
  claims?: JWTPayload
}): Promise<string> {
  let builder = new SignJWT(opts.claims ?? {})
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'test-key' })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('2m')
  if (opts.sub !== undefined) builder = builder.setSubject(opts.sub)
  return builder.sign(opts.privateKey)
}

function strategy(
  issuer: string,
  extra: { preset?: OidcPreset; tenantClaim?: string } = {},
  options: { header?: string } = {},
) {
  const entry: OidcIssuer = { issuer, audience: AUDIENCE }
  if (extra.preset !== undefined) entry.preset = extra.preset
  if (extra.tenantClaim !== undefined) entry.tenantClaim = extra.tenantClaim
  if (options.header !== undefined) return oidcStrategy({ issuers: [entry], header: options.header })
  return oidcStrategy({ issuers: [entry] })
}

afterAll(() => {
  for (const server of servers) server.stop(true)
})

describe('oidc strategy', () => {
  let primary: IssuerServer

  beforeAll(async () => {
    primary = await startIssuer()
  })

  function key(): MintedKey {
    return firstKey(primary)
  }

  async function token(opts: { issuer?: string; sub?: string; claims?: JWTPayload; audience?: string; key?: MintedKey } = {}) {
    const signing = opts.key ?? key()
    return signToken({
      privateKey: signing.privateKey,
      kid: signing.kid,
      issuer: opts.issuer ?? primary.issuer,
      ...(opts.sub !== undefined ? { sub: opts.sub } : {}),
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      ...(opts.claims !== undefined ? { claims: opts.claims } : {}),
    })
  }

  test('a discovered token sets subject, claims, and principal with iss and sub', async () => {
    const strat = strategy(primary.issuer)
    const signed = await token({ sub: 'user-1', claims: { role: 'admin' } })
    const identity = await strat.authenticate(authed(signed))
    expect(identity?.subject).toBe('user-1')
    expect(identity?.claims).toMatchObject({ sub: 'user-1', iss: primary.issuer, role: 'admin' })
    expect(identity?.principal).toEqual({ iss: primary.issuer, sub: 'user-1' })
    expect(identity?.principal).not.toHaveProperty('tenant')
    expect(strat.name).toBe('oidc')
  })

  test("a token signed by issuer B does not verify against issuer A's keys", async () => {
    const issuerB = await startIssuer()
    const keyB = firstKey(issuerB)
    const strat = oidcStrategy({
      issuers: [
        { issuer: primary.issuer, audience: AUDIENCE },
        { issuer: issuerB.issuer, audience: AUDIENCE },
      ],
    })
    const cross = await signToken({
      privateKey: key().privateKey,
      kid: key().kid,
      issuer: issuerB.issuer,
      sub: 'user-b',
    })
    const ok = await signToken({
      privateKey: keyB.privateKey,
      kid: keyB.kid,
      issuer: issuerB.issuer,
      sub: 'user-b',
    })
    expect(await strat.authenticate(authed(cross))).toBeNull()
    expect((await strat.authenticate(authed(ok)))?.principal).toEqual({
      iss: issuerB.issuer,
      sub: 'user-b',
    })
  })

  test('the token kid selects the matching key from one JWKS', async () => {
    const first = await mintedKey('key-1')
    const second = await mintedKey('key-2')
    const server = await startIssuer({ keys: [first, second] })
    const strat = strategy(server.issuer)
    const selected = await signToken({
      privateKey: second.privateKey,
      kid: second.kid,
      issuer: server.issuer,
      sub: 'user-2',
    })
    const other = await signToken({
      privateKey: first.privateKey,
      kid: first.kid,
      issuer: server.issuer,
      sub: 'user-1',
    })
    const swapped = await signToken({
      privateKey: first.privateKey,
      kid: second.kid,
      issuer: server.issuer,
      sub: 'user-2',
    })
    expect((await strat.authenticate(authed(selected)))?.principal).toEqual({
      iss: server.issuer,
      sub: 'user-2',
    })
    expect((await strat.authenticate(authed(other)))?.principal).toEqual({
      iss: server.issuer,
      sub: 'user-1',
    })
    expect(await strat.authenticate(authed(swapped))).toBeNull()
  })

  test('an iss that is not configured returns null', async () => {
    const evil = await startIssuer()
    const evilKey = firstKey(evil)
    const strat = strategy(primary.issuer)
    const signed = await signToken({
      privateKey: evilKey.privateKey,
      kid: evilKey.kid,
      issuer: evil.issuer,
      sub: 'user-1',
    })
    expect(await strat.authenticate(authed(signed))).toBeNull()
  })

  test('a token with no sub returns null', async () => {
    const strat = strategy(primary.issuer)
    const missing = await token({})
    const empty = await token({ claims: { sub: '' } })
    expect(await strat.authenticate(authed(missing))).toBeNull()
    expect(await strat.authenticate(authed(empty))).toBeNull()
  })

  test('entra copies tid', async () => {
    const strat = strategy(primary.issuer, { preset: 'entra' })
    const signed = await token({ sub: 'user-1', claims: { tid: 'tenant-guid' } })
    expect((await strat.authenticate(authed(signed)))?.principal).toEqual({
      iss: primary.issuer,
      sub: 'user-1',
      tenant: 'tenant-guid',
    })
  })

  test('a missing or empty entra tid still authenticates with tenant unset', async () => {
    const strat = strategy(primary.issuer, { preset: 'entra' })
    const missing = await token({ sub: 'user-1' })
    const empty = await token({ sub: 'user-1', claims: { tid: '' } })
    for (const signed of [missing, empty]) {
      const identity = await strat.authenticate(authed(signed))
      expect(identity?.subject).toBe('user-1')
      expect(identity?.principal).toEqual({ iss: primary.issuer, sub: 'user-1' })
      expect(identity?.principal).not.toHaveProperty('tenant')
    }
  })

  test('cognito copies custom:tenant when present', async () => {
    const strat = strategy(primary.issuer, { preset: 'cognito' })
    const signed = await token({ sub: 'user-1', claims: { 'custom:tenant': 'acme' } })
    expect((await strat.authenticate(authed(signed)))?.principal).toEqual({
      iss: primary.issuer,
      sub: 'user-1',
      tenant: 'acme',
    })
  })

  test('google copies hd when present and leaves tenant unset when hd is absent', async () => {
    const strat = strategy(primary.issuer, { preset: 'google' })
    const present = await token({ sub: 'user-1', claims: { hd: 'example.com' } })
    const absent = await token({ sub: 'user-1' })
    expect((await strat.authenticate(authed(present)))?.principal).toEqual({
      iss: primary.issuer,
      sub: 'user-1',
      tenant: 'example.com',
    })
    const identity = await strat.authenticate(authed(absent))
    expect(identity?.principal).toEqual({ iss: primary.issuer, sub: 'user-1' })
    expect(identity?.principal).not.toHaveProperty('tenant')
  })

  test('a google preset at https://accounts.google.com accepts both iss values', async () => {
    const signing = await mintedKey('google-key')
    const jwks = track(Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ keys: [signing.jwk] }),
    }))
    const configured = 'https://accounts.google.com'
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === `${configured}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: configured,
          jwks_uri: `http://127.0.0.1:${jwks.port}/jwks`,
        })
      }
      return original(input, init)
    }) as typeof fetch
    try {
      const strat = strategy(configured, { preset: 'google' })
      const bare = await signToken({
        privateKey: signing.privateKey,
        kid: signing.kid,
        issuer: 'accounts.google.com',
        sub: 'user-1',
      })
      const httpsIss = await signToken({
        privateKey: signing.privateKey,
        kid: signing.kid,
        issuer: configured,
        sub: 'user-1',
      })
      expect((await strat.authenticate(authed(bare)))?.principal).toEqual({
        iss: 'accounts.google.com',
        sub: 'user-1',
      })
      expect((await strat.authenticate(authed(httpsIss)))?.principal).toEqual({
        iss: configured,
        sub: 'user-1',
      })
    } finally {
      globalThis.fetch = original
    }
  })

  test('auth0 copies org_id when present', async () => {
    const strat = strategy(primary.issuer, { preset: 'auth0' })
    const signed = await token({ sub: 'user-1', claims: { org_id: 'org_123' } })
    expect((await strat.authenticate(authed(signed)))?.principal).toEqual({
      iss: primary.issuer,
      sub: 'user-1',
      tenant: 'org_123',
    })
  })

  test('okta and keycloak set no tenant claim', async () => {
    const claims = {
      tid: 'tid',
      'custom:tenant': 'cog',
      hd: 'hd',
      org_id: 'org',
      tenant: 'plain',
    }
    for (const preset of ['okta', 'keycloak'] as const) {
      const strat = strategy(primary.issuer, { preset })
      const signed = await token({ sub: 'user-1', claims })
      const identity = await strat.authenticate(authed(signed))
      expect(identity?.principal).toEqual({ iss: primary.issuer, sub: 'user-1' })
      expect(identity?.principal).not.toHaveProperty('tenant')
    }
  })

  test('an explicit tenantClaim that is missing or empty returns null', async () => {
    const strat = strategy(primary.issuer, { preset: 'entra', tenantClaim: 'org_id' })
    const empty = await token({ sub: 'user-1', claims: { org_id: '', tid: 'from-preset' } })
    const missing = await token({ sub: 'user-1', claims: { tid: 'from-preset' } })
    const numeric = await token({ sub: 'user-1', claims: { org_id: 42, tid: 'from-preset' } })
    expect(await strat.authenticate(authed(empty))).toBeNull()
    expect(await strat.authenticate(authed(missing))).toBeNull()
    expect(await strat.authenticate(authed(numeric))).toBeNull()
  })

  test('an explicit tenantClaim overrides the preset', async () => {
    const strat = strategy(primary.issuer, { preset: 'entra', tenantClaim: 'org_id' })
    const signed = await token({ sub: 'user-1', claims: { tid: 'from-preset', org_id: 'org-1' } })
    expect((await strat.authenticate(authed(signed)))?.principal).toEqual({
      iss: primary.issuer,
      sub: 'user-1',
      tenant: 'org-1',
    })
  })

  test('a discovery document whose issuer does not match the configured issuer returns null', async () => {
    const mismatch = await startIssuer({ documentIssuer: 'https://wrong.example' })
    const signing = firstKey(mismatch)
    const strat = strategy(mismatch.issuer)
    const signed = await signToken({
      privateKey: signing.privateKey,
      kid: signing.kid,
      issuer: mismatch.issuer,
      sub: 'user-1',
    })
    expect(await strat.authenticate(authed(signed))).toBeNull()
  })

  test('a jwks_uri on a different port is accepted', async () => {
    const real = await mintedKey('remote-key')
    const decoy = await mintedKey('decoy-key')
    const jwks = track(Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ keys: [real.jwk] }),
    }))
    const discovery = await startIssuer({
      keys: [decoy],
      jwksUri: `http://127.0.0.1:${jwks.port}/jwks`,
    })
    const strat = strategy(discovery.issuer)
    const signed = await signToken({
      privateKey: real.privateKey,
      kid: real.kid,
      issuer: discovery.issuer,
      sub: 'user-1',
    })
    const identity = await strat.authenticate(authed(signed))
    expect(jwks.port).not.toBe(discovery.server.port)
    expect(identity?.principal).toEqual({ iss: discovery.issuer, sub: 'user-1' })
  })

  test('an http jwks_uri that is not loopback returns null', async () => {
    const server = await startIssuer({ jwksUri: 'http://10.1.1.1/jwks' })
    const signing = firstKey(server)
    const strat = strategy(server.issuer)
    const signed = await signToken({
      privateKey: signing.privateKey,
      kid: signing.kid,
      issuer: server.issuer,
      sub: 'user-1',
    })
    expect(await strat.authenticate(authed(signed))).toBeNull()
  })

  test('a discovery response of 302 to another server returns null and that server receives no request', async () => {
    const attackerKey = await mintedKey('attacker-key')
    let configured = ''
    let attackerHits = 0
    const attacker = track(Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        attackerHits += 1
        const path = new URL(req.url).pathname
        if (path === '/jwks') return Response.json({ keys: [attackerKey.jwk] })
        return Response.json({
          issuer: configured,
          jwks_uri: `http://127.0.0.1:${attacker.port}/jwks`,
        })
      },
    }))
    const redirector = track(Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: {
            location: `http://127.0.0.1:${attacker.port}/.well-known/openid-configuration`,
          },
        })
      },
    }))
    configured = `http://127.0.0.1:${redirector.port}`
    const strat = strategy(configured)
    const signed = await signToken({
      privateKey: attackerKey.privateKey,
      kid: attackerKey.kid,
      issuer: configured,
      sub: 'user-1',
    })
    expect(await strat.authenticate(authed(signed))).toBeNull()
    expect(attackerHits).toBe(0)
  })

  test('a hung discovery fetch returns null and the next authenticate fetches again', async () => {
    let fetches = 0
    const hung = track(Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        fetches += 1
        return new Promise(() => {})
      },
    }))
    const issuer = `http://127.0.0.1:${hung.port}`
    const signing = await mintedKey('hung-key')
    const strat = strategy(issuer)
    const signed = await signToken({
      privateKey: signing.privateKey,
      kid: signing.kid,
      issuer,
      sub: 'user-1',
    })
    expect(await strat.authenticate(authed(signed))).toBeNull()
    expect(fetches).toBe(1)
    expect(await strat.authenticate(authed(signed))).toBeNull()
    expect(fetches).toBe(2)
  }, 20000)

  test('a trailing slash is stripped before discovery', async () => {
    const slash = await startIssuer({ trailingSlash: true })
    const signing = firstKey(slash)
    const strat = strategy(slash.issuer)
    const urls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
      return original(input, init)
    }) as typeof fetch
    try {
      const signed = await signToken({
        privateKey: signing.privateKey,
        kid: signing.kid,
        issuer: slash.issuer,
        sub: 'user-1',
      })
      const identity = await strat.authenticate(authed(signed))
      const origin = slash.issuer.slice(0, -1)
      expect(identity?.principal).toEqual({ iss: slash.issuer, sub: 'user-1' })
      expect(urls).toContain(`${origin}/.well-known/openid-configuration`)
      expect(urls.some((url) => url.includes('//.well-known'))).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })

  test('a failed audience check returns null', async () => {
    const strat = strategy(primary.issuer)
    const signed = await token({ sub: 'user-1', audience: 'other-api' })
    expect(await strat.authenticate(authed(signed))).toBeNull()
  })

  test('a missing or empty token header returns null', async () => {
    const strat = strategy(primary.issuer)
    expect(await strat.authenticate(reqWith({}))).toBeNull()
    expect(await strat.authenticate(reqWith({ authorization: '' }))).toBeNull()
    expect(await strat.authenticate(reqWith({ authorization: 'Bearer ' }))).toBeNull()
  })

  test('reads the token from the configured header only', async () => {
    const strat = strategy(primary.issuer, {}, { header: 'x-access-token' })
    const signed = await token({ sub: 'user-1' })
    expect(
      await strat.authenticate(reqWith({ 'x-access-token': `Bearer ${signed}` })),
    ).toMatchObject({ subject: 'user-1', principal: { iss: primary.issuer, sub: 'user-1' } })
    expect(await strat.authenticate(authed(signed))).toBeNull()
  })
})

describe('oidc strategy — construction', () => {
  test('an http issuer other than localhost throws at construction', () => {
    expect(() => oidcStrategy({
      issuers: [{ issuer: 'http://issuer.example', audience: AUDIENCE }],
    })).toThrow(/http:\/\/localhost or http:\/\/127\.0\.0\.1/)
    expect(() => oidcStrategy({
      issuers: [{ issuer: 'http://127.0.0.2', audience: AUDIENCE }],
    })).toThrow(/127\.0\.0\.1/)
    expect(() => oidcStrategy({
      issuers: [{ issuer: 'https://accounts.google.com', audience: AUDIENCE }],
    })).not.toThrow()
    expect(() => oidcStrategy({
      issuers: [{ issuer: 'http://localhost/realms/demo', audience: AUDIENCE }],
    })).not.toThrow()
    expect(() => oidcStrategy({
      issuers: [{ issuer: 'http://127.0.0.1:9/realms/demo', audience: AUDIENCE }],
    })).not.toThrow()
  })

  test('a symmetric algorithm throws at construction', () => {
    const issuers = [{ issuer: 'https://issuer.example', audience: AUDIENCE }]
    expect(() => oidcStrategy({ issuers, algorithms: ['HS256'] })).toThrow(/HS256/)
    expect(() => oidcStrategy({ issuers, algorithms: ['RS256', 'HS384'] })).toThrow(/HS384/)
  })

  test('an algorithm outside the oidc allowlist throws at construction', () => {
    const issuers = [{ issuer: 'https://issuer.example', audience: AUDIENCE }]
    expect(() => oidcStrategy({ issuers, algorithms: ['PS256'] })).toThrow(/PS256/)
    expect(() => oidcStrategy({ issuers, algorithms: ['none'] })).toThrow(/none/)
    expect(() => oidcStrategy({
      issuers,
      algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'EdDSA'],
    })).not.toThrow()
  })

  test('an empty issuer list throws at construction', () => {
    expect(() => oidcStrategy({ issuers: [] })).toThrow(/at least one oidc issuer/)
  })

  test('a duplicate issuer throws at construction', () => {
    expect(() => oidcStrategy({
      issuers: [
        { issuer: 'https://issuer.example', audience: 'a' },
        { issuer: 'https://issuer.example', audience: 'b' },
      ],
    })).toThrow(/duplicate oidc issuer/)
  })

  test('an empty issuer or audience throws at construction', () => {
    expect(() => oidcStrategy({
      issuers: [{ issuer: '', audience: AUDIENCE }],
    })).toThrow(/oidc issuer must not be empty/)
    expect(() => oidcStrategy({
      issuers: [{ issuer: 'https://issuer.example', audience: '' }],
    })).toThrow(/oidc audience must not be empty/)
  })
})
