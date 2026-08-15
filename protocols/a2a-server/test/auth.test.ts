import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BreadAuthStrategy } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import type { Hono } from 'hono'
import { defineTestAgent, makeServer, mockTextModel } from '@breadai/test-utils'
import { a2aServer } from '../src/index.js'

// Same pattern as protocols/mcp-server/test/auth.test.ts: a2a_server adds no
// auth logic of its own — both the well-known Agent Card and the RPC route
// ride the server's generic middleware gate for free, regardless of plugin
// registration order (a2aServer listed first here, authPlugin second).
const apiKeyStrategy: BreadAuthStrategy = {
  name: 'api-key',
  authenticate: (req) => (req.headers.get('x-api-key') === 'secret' ? { subject: 'tester' } : null),
}

describe("a2a_server — inherits the server's auth gate", () => {
  let app: Hono
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('ok'),
      plugins: [
        a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' }),
        a2aServer({
          agentId: 'greeter',
          url: 'http://localhost/a2a-v1',
          specVersion: '1.0',
          cardPath: '/.well-known/agent-card-v1.json',
        }),
        authPlugin([apiKeyStrategy]),
      ],
    }))
  })

  afterEach(() => stop())

  test('rejects an unauthenticated Agent Card request with 401', async () => {
    const res = await app.request('/.well-known/agent-card.json')
    expect(res.status).toBe(401)
  })

  test('allows an authenticated Agent Card request through', async () => {
    const res = await app.request('/.well-known/agent-card.json', {
      headers: { 'x-api-key': 'secret' },
    })
    expect(res.status).not.toBe(401)
  })

  // Regression coverage for the same-process dual-mount collision: both a2aServer() mounts above
  // register a GET handler for their own cardPath — without a distinct path per mount, only the
  // first-registered handler is ever reachable (Hono, silently). Asserting the actual Card content
  // (not just a status code) at each mount's own path proves both are genuinely independent.
  test('serves the v0.3 mount\'s own Card, with the v0.3 shape, at its own cardPath', async () => {
    const res = await app.request('/.well-known/agent-card.json', {
      headers: { 'x-api-key': 'secret' },
    })
    expect(res.status).toBe(200)
    const card = await res.json()
    expect(card.protocolVersion).toBe('0.3.0')
    expect(card.url).toBe('http://localhost/a2a')
  })

  test('serves the v1.0 mount\'s own Card, with the v1.0 shape, at its distinct cardPath', async () => {
    const res = await app.request('/.well-known/agent-card-v1.json', {
      headers: { 'x-api-key': 'secret' },
    })
    expect(res.status).toBe(200)
    const card = await res.json()
    expect(card.supportedInterfaces).toEqual([{ url: 'http://localhost/a2a-v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }])
  })

  test('rejects an unauthenticated message/send request with 401', async () => {
    const res = await app.request('/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1', kind: 'message' } },
      }),
    })
    expect(res.status).toBe(401)
  })

  test('allows an authenticated message/send request through', async () => {
    const res = await app.request('/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1', kind: 'message' } },
      }),
    })
    expect(res.status).not.toBe(401)
  })

  test('rejects an unauthenticated message/stream request with 401', async () => {
    const res = await app.request('/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1', kind: 'message' } },
      }),
    })
    expect(res.status).toBe(401)
  })

  test('allows an authenticated message/stream request through', async () => {
    const res = await app.request('/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1', kind: 'message' } },
      }),
    })
    expect(res.status).not.toBe(401)
  })

  // Task-lifecycle methods, both spec versions. `id: 'nonexistent'` is safe
  // here — the not-found short-circuit resolves before any stream opens, so
  // these stay plain, non-hanging requests regardless of auth outcome.
  for (const [path, method] of [
    ['/a2a', 'tasks/get'],
    ['/a2a', 'tasks/resubscribe'],
    ['/a2a-v1', 'GetTask'],
    ['/a2a-v1', 'SubscribeToTask'],
  ] as const) {
    test(`rejects an unauthenticated ${method} request with 401`, async () => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { id: 'nonexistent' } }),
      })
      expect(res.status).toBe(401)
    })

    test(`allows an authenticated ${method} request through`, async () => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { id: 'nonexistent' } }),
      })
      expect(res.status).not.toBe(401)
    })
  }
})
