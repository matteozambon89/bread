import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { defineTestAgent, makeServer, mockTextModel } from '@breadai/test-utils'

describe('body-size limit', () => {
  let app: Hono
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, stop } = await makeServer({
      agents: { writer: defineTestAgent() },
      model: mockTextModel('ok'),
      config: { server: { maxBodyBytes: 64 } },
    }))
  })

  afterEach(() => stop())

  test('body over the configured limit gets a 413 with the standard error shape', async () => {
    const res = await app.request('/agents/writer/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'x'.repeat(200) }),
    })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('BODY_TOO_LARGE')
    expect(typeof body.error.message).toBe('string')
  })

  test('body within the limit still runs normally', async () => {
    const res = await app.request('/agents/writer/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
    })
    expect(res.status).toBe(200)
  })
})
