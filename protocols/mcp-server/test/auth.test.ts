import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BreadAuthStrategy } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import type { Hono } from 'hono'
import { defineTestAgent, makeServer, mockTextModel } from '@breadai/test-utils'
import { mcpServer } from '@breadai/protocol-mcp-server'

// An auth strategy that accepts requests carrying the right header — the
// same pattern packages/server/test/auth.test.ts uses for the rest of the
// server's routes. mcp_server adds no auth logic of its own: this proves the
// /mcp route rides through the generic middleware pass for free, regardless
// of plugin registration order (mcp_server's plugin is listed first here,
// authPlugin's second — the middleware pass still runs before both plugins'
// routes are registered).
const apiKeyStrategy: BreadAuthStrategy = {
  name: 'api-key',
  authenticate: (req) => (req.headers.get('x-api-key') === 'secret' ? { subject: 'tester' } : null),
}

describe('mcp_server — inherits the server\'s auth gate', () => {
  let app: Hono
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('ok'),
      plugins: [mcpServer({ transport: 'http', agents: ['greeter'] }), authPlugin([apiKeyStrategy])],
    }))
  })

  afterEach(() => stop())

  // Real HTTP/1.1 clients always send Host and a permissive Accept; Hono's
  // in-process app.request() synthesizes neither — mcp_server's localhost-only
  // DNS-rebinding check (host) and the v2 SDK's own Streamable HTTP handler
  // (accept) both reject a request missing them, ahead of and independent of
  // this plugin's auth gate. Both headers are set on every request below so
  // each test isolates the one thing it actually claims to prove.
  const mcpHeaders = { 'content-type': 'application/json', host: 'localhost', accept: 'application/json, text/event-stream' }

  test('rejects an unauthenticated MCP request with 401', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })

  test('allows an authenticated MCP request through', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, 'x-api-key': 'secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(200)
    // The SDK answers a single-response exchange as one SSE event by default
    // (`content-type: text/event-stream`) rather than a bare JSON body — pull
    // the JSON-RPC payload out of its `data:` line.
    const text = await res.text()
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '))
    const body = JSON.parse(dataLine!.slice('data: '.length)) as { result?: { tools?: { name: string }[] } }
    expect(body.result?.tools?.map((t) => t.name)).toContain('greeter')
  })
})
