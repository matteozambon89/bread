import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BreadAuthStrategy } from '@bread/core'
import { authPlugin } from '@bread/server'
import type { Hono } from 'hono'
import { defineTestAgent, makeServer, mockTextModel } from '@bread/test-utils'
import { mcpServer } from '@bread/protocol-mcp-server'

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

  test('rejects an unauthenticated MCP request with 401', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })

  test('allows an authenticated MCP request through', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).not.toBe(401)
  })
})
