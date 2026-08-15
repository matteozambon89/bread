import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { defineTestAgent, makeServer, mockTextModel, readSse } from '@breadai/test-utils'

describe('server — pipeline route', () => {
  let app: Hono
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, stop } = await makeServer({
      agents: { a: defineTestAgent({ model: 'a' }), b: defineTestAgent({ model: 'b' }) },
      models: { a: mockTextModel('FROM_A'), b: mockTextModel('FROM_B') },
      config: {
        pipelines: {
          chain: [
            { type: 'agent', agentId: 'a' },
            { type: 'agent', agentId: 'b' },
          ],
        },
      },
    }))
  })

  afterEach(() => stop())

  test('POST /pipelines/:id/run streams step crumbs', async () => {
    const res = await app.request('/pipelines/chain/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
    })
    const types = (await readSse(res)).map((e) => e.type)
    expect(types).toContain('pipeline:step:start')
    expect(types).toContain('pipeline:step:end')
  })

  test('POST /pipelines/:id/run surfaces an unknown pipeline as an in-stream error, not a 404', async () => {
    // mount() has no private config.pipelines access to pre-check existence —
    // runPipeline() throws synchronously, caught the same way as a lazy failure.
    const res = await app.request('/pipelines/nope/run', { method: 'POST' })
    expect(res.status).toBe(200)
    const [event] = await readSse(res)
    expect(event!.type).toBe('error')
    expect((event!.payload as { code: string }).code).toBe('PIPELINE_NOT_FOUND')
  })
})
