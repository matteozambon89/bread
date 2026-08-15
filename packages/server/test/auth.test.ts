import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BreadAuthStrategy } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import type { Hono } from 'hono'
import { defineTestAgent, makeServer, mockTextModel } from '@breadai/test-utils'

// An auth strategy that accepts requests carrying the right header.
const apiKeyStrategy: BreadAuthStrategy = {
  name: 'api-key',
  authenticate: (req) => (req.headers.get('x-api-key') === 'secret' ? { subject: 'tester' } : null),
}

describe('server — auth gating', () => {
  let app: Hono
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, stop } = await makeServer({
      agents: { a: defineTestAgent() },
      model: mockTextModel('ok'),
      plugins: [authPlugin([apiKeyStrategy])],
    }))
  })

  afterEach(() => stop())

  test('rejects an unauthenticated request with 401', async () => {
    const res = await app.request('/agents')
    expect(res.status).toBe(401)
  })

  test('allows a request carrying a valid credential', async () => {
    const res = await app.request('/agents', { headers: { 'x-api-key': 'secret' } })
    expect(res.status).toBe(200)
  })
})
