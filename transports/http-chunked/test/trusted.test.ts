import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { defineTool } from '@breadai/core'
import type { Principal } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import { authStrategy } from '@breadai/auth-trusted'
import { defineTestAgent, makeServer, mockToolCallModel } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-chunked'
import { SignJWT, type KeyLike, exportJWK, generateKeyPair } from 'jose'
import { z } from 'zod'

const ISSUER = 'https://gateway.example'
const tokenPrincipal: Principal = { iss: ISSUER, sub: 'user-1', tenant: 'acme' }
const spoof: Principal = { iss: 'https://evil.example', sub: 'spoof', tenant: 'forged' }

function probe(seen: Array<Principal | undefined>) {
  return defineTool({
    name: 'probe',
    description: 'Record the run principal',
    schema: z.object({
      principal: z.object({ iss: z.string(), sub: z.string() }).optional(),
    }),
    execute: async (_args, ctx) => {
      seen.push(ctx.principal)
      return { ok: true }
    },
  })
}

describe('http chunked trusted identity', () => {
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

  test('a gateway token principal reaches the tool and a body principal or x-user-id does not', async () => {
    const seen: Array<Principal | undefined> = []
    const strategy = authStrategy({ jwksUri, issuer: ISSUER, tenantClaim: 'tenant' })
    const token = await new SignJWT({ sub: tokenPrincipal.sub, tenant: tokenPrincipal.tenant })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateKey)
    const { app, stop } = await makeServer({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
      plugins: [authPlugin([strategy])],
      config: { transport: transport(), server: { authorize: () => true } },
    })
    try {
      const res = await app.request('/agents/agent/run', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-user-id': 'spoof',
          'x-forwarded-user': 'spoof',
          'x-forwarded-email': 'spoof@evil.example',
        },
        body: JSON.stringify({ input: 'go', principal: spoof }),
      })
      expect(res.status).toBe(200)
      await res.text()
      expect(seen).toEqual([tokenPrincipal])
    } finally {
      await stop()
    }
  })
})
