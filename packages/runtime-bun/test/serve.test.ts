import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import type { AuthIdentity } from '@breadai/core'
import { mtlsStrategy } from '../../../extensions/auth-trusted/src/index.ts'
import { authPlugin } from '@breadai/server'
import { issueMtlsCerts, requestMtls, type MtlsCerts } from '../../server/test/mtls-certs.ts'
import type { AgentRegistry, BreadConfig } from '@breadai/core'
import { startServer } from '@breadai/runtime-bun'
import { store } from '@breadai/store-memory'
import { transport } from '@breadai/transport-http-sse'
import { defineTestAgent, mockProvider, mockTextModel } from '@breadai/test-utils'

// Smoke tests for the port-binding path (`bread dev`/`bread start` both call
// startServer, which binds via Bun.serve).

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

function fixture(): { config: BreadConfig; agents: AgentRegistry } {
  const config: BreadConfig = {
    entrypoints: ['greeter'],
    store: store(),
    transport: transport(),
    providers: mockProvider({ default: mockTextModel('served') }),
  }
  const agents: AgentRegistry = new Map([['greeter', defineTestAgent()]])
  return { config, agents }
}

describe('startServer', () => {
  let stop: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  test('binds a real port and serves the HTTP API', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port }))

    const res = await fetch(`http://localhost:${port}/agents`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Array<{ id: string }>).map((a) => a.id)).toEqual(['greeter'])
  })

  test('serves end to end', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port }))

    const res = await fetch(`http://localhost:${port}/agents/greeter/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toContain('served')
  })

  test('config.server.port is honoured when no port override is passed', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    config.server = { port }
    ;({ stop } = await startServer(config, agents))

    const res = await fetch(`http://localhost:${port}/agents`)
    expect(res.status).toBe(200)
  })

  test('an explicit port override beats config.server.port', async () => {
    const { config, agents } = fixture()
    const configPort = freePort()
    const flagPort = freePort()
    config.server = { port: configPort }
    ;({ stop } = await startServer(config, agents, { port: flagPort }))

    const res = await fetch(`http://localhost:${flagPort}/agents`)
    expect(res.status).toBe(200)
  })

  test('stop() releases the port for reuse', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const first = await startServer(config, agents, { port })
    await first.stop()

    // Rebinding the same port only works if stop() actually closed the server.
    ;({ stop } = await startServer(fixture().config, fixture().agents, { port }))
    const res = await fetch(`http://localhost:${port}/agents`)
    expect(res.status).toBe(200)
  })
})

const SPOOF_HEADERS = {
  'x-user-id': 'spoof',
  'x-forwarded-user': 'spoof',
  'x-forwarded-email': 'spoof@evil.example',
  'ssl-client-cert': 'spoof',
  'x-forwarded-client-cert': 'spoof',
}

describe('startServer mTLS', () => {
  let stop: (() => Promise<void>) | undefined
  let certs: MtlsCerts

  beforeAll(async () => {
    certs = await issueMtlsCerts()
  })

  afterAll(async () => {
    await certs.cleanup()
  })

  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  test('plain HTTP does not attach a peer from client cert headers', async () => {
    const { config, agents } = fixture()
    config.plugins = [authPlugin([mtlsStrategy({ issuer: 'gateway-ca', tenantField: 'ou' })])]
    config.server = { authorize: () => true }
    const port = freePort()
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      ;({ stop } = await startServer(config, agents, { port, host: '127.0.0.1' }))
    } finally {
      console.log = original
    }
    const res = await fetch(`http://127.0.0.1:${port}/agents`, { headers: SPOOF_HEADERS })
    expect(res.status).toBe(401)
    expect(lines.some((line) => line.includes(`http://127.0.0.1:${port}`))).toBe(true)
    expect(lines.some((line) => line.includes('https://'))).toBe(false)
  })

  test('partial tls throws TLS_NOT_CONFIGURED before listen', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    config.server = { tls: { key: '', cert: 'pem', ca: 'pem' } }
    await expect(startServer(config, agents, { port, host: '127.0.0.1' })).rejects.toMatchObject({
      code: 'TLS_NOT_CONFIGURED',
    })
    ;({ stop } = await startServer(fixture().config, fixture().agents, { port, host: '127.0.0.1' }))
    const res = await fetch(`http://127.0.0.1:${port}/agents`)
    expect(res.status).toBe(200)
  })

  test('a public bind with tls but no auth still throws AUTH_NOT_CONFIGURED', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    config.server = { tls: certs.server }
    await expect(startServer(config, agents, { port, host: '0.0.0.0' })).rejects.toMatchObject({
      code: 'AUTH_NOT_CONFIGURED',
    })
  })

  test('tls does not install auth and a client cert is enough on loopback', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    config.server = { tls: certs.server }
    ;({ stop } = await startServer(config, agents, { port, host: '127.0.0.1' }))
    const res = await requestMtls({
      port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      path: '/agents',
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('greeter')
  })

  test('a verified client cert sets principal and forwarded headers do not', async () => {
    const seen: AuthIdentity[] = []
    const { config, agents } = fixture()
    const port = freePort()
    config.plugins = [authPlugin([mtlsStrategy({ issuer: 'gateway-ca', tenantField: 'ou' })])]
    config.server = {
      tls: certs.server,
      authorize(identity) {
        seen.push(identity)
        return true
      },
    }
    ;({ stop } = await startServer(config, agents, { port, host: '127.0.0.1' }))
    const res = await requestMtls({
      port,
      ca: certs.ca,
      cert: certs.client.cert,
      key: certs.client.key,
      path: '/agents',
      headers: SPOOF_HEADERS,
    })
    expect(res.status).toBe(200)
    expect(seen[0]?.principal).toEqual({ iss: 'mtls:gateway-ca', sub: 'user-1', tenant: 'acme' })
    expect(seen[0]?.subject).toBe('user-1')
    expect(seen[0]?.claims).toMatchObject({
      fingerprint256: new X509Certificate(certs.client.cert).fingerprint256,
    })
  })
})
