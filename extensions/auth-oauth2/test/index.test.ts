import { afterEach, describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import { authStrategy, signer } from '@breadai/auth-oauth2'

const SECRET = 'oauth-verify-secret'

interface TokenStub {
  access_token: string
  expires_in?: number
}

// Captures every outgoing token request and replies with a configurable body so
// the client-credentials grant can be asserted without a real network call.
function stubFetch(reply: () => { status?: number; body: TokenStub | string }) {
  const calls: { url: string; init: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const { status = 200, body } = reply()
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(payload, { status })
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = original) }
}

function reqWith(headers: Record<string, string>): Request {
  return new Request('http://x/agents', { headers })
}

const clientOpts = {
  tokenUrl: 'https://idp.example/token',
  clientId: 'client-1',
  clientSecret: 'shh',
}

describe('oauth2 signer — client-credentials grant', () => {
  let fetchStub: ReturnType<typeof stubFetch>

  afterEach(() => fetchStub?.restore())

  test('exchanges credentials for a token and attaches it as a Bearer header', async () => {
    fetchStub = stubFetch(() => ({ body: { access_token: 'tok-abc', expires_in: 3600 } }))
    const sign = signer({ ...clientOpts, scope: 'read write' })

    const headers = new Headers()
    await sign.sign(headers)

    expect(headers.get('authorization')).toBe('Bearer tok-abc')
    expect(fetchStub.calls).toHaveLength(1)
    const body = (fetchStub.calls[0]!.init.body as URLSearchParams).toString()
    expect(body).toContain('grant_type=client_credentials')
    expect(body).toContain('client_id=client-1')
    expect(body).toContain('client_secret=shh')
    expect(body).toContain('scope=read+write')
  })

  test('caches a still-valid token instead of re-fetching', async () => {
    fetchStub = stubFetch(() => ({ body: { access_token: 'cached', expires_in: 3600 } }))
    const sign = signer(clientOpts)

    await sign.sign(new Headers())
    await sign.sign(new Headers())

    expect(fetchStub.calls).toHaveLength(1)
  })

  test('re-fetches once the cached token is within the expiry window', async () => {
    // expires_in below the 5s refresh skew means the cache is never reused.
    fetchStub = stubFetch(() => ({ body: { access_token: 'short', expires_in: 1 } }))
    const sign = signer(clientOpts)

    await sign.sign(new Headers())
    await sign.sign(new Headers())

    expect(fetchStub.calls).toHaveLength(2)
  })

  test('throws with status and body when the token endpoint fails', async () => {
    fetchStub = stubFetch(() => ({ status: 401, body: 'invalid_client' }))
    const sign = signer(clientOpts)
    expect(sign.sign(new Headers())).rejects.toThrow(/401 invalid_client/)
  })
})

describe('oauth2 authStrategy — bearer verification', () => {
  test('delegates incoming token validation to the jwt verifier', async () => {
    const strat = authStrategy({ secret: SECRET, allowUnverifiedIssuerAudience: true })
    const token = await new SignJWT({ sub: 'svc-account' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .sign(new TextEncoder().encode(SECRET))
    expect(await strat.authenticate(reqWith({ authorization: `Bearer ${token}` }))).toMatchObject({
      subject: 'svc-account',
    })
    expect(await strat.authenticate(reqWith({ authorization: 'Bearer garbage' }))).toBeNull()
  })

  test('names the strategy "oauth2", not "jwt"', () => {
    const strat = authStrategy({ secret: SECRET, allowUnverifiedIssuerAudience: true })
    expect(strat.name).toBe('oauth2')
  })
})
