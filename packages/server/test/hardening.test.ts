import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BreadInstance } from '@bread/core'
import type { Hono } from 'hono'
import { defineTestAgent, makeServer, mockErrorModel, mockTextModel, readSse } from '@bread/test-utils'

describe('SSE error sanitization', () => {
  let app: Hono
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, stop } = await makeServer({
      agents: {
        broken: defineTestAgent({ config: { model: { provider: 'ghost', model: 'x' } } }),
      },
      model: mockErrorModel('unused — resolution fails first'),
    }))
  })

  afterEach(() => stop())

  test('terminal error event carries code + message only', async () => {
    const res = await app.request('/agents/broken/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
    })
    const events = await readSse(res)
    const terminal = events.at(-1)!
    expect(terminal.type).toBe('error')
    const payload = terminal.payload as Record<string, unknown>
    expect(payload.code).toBe('UNKNOWN_PROVIDER')
    expect(typeof payload.message).toBe('string')
    expect(Object.keys(payload).sort()).toEqual(['code', 'message'])
  })

  test('agent:error crumb payloads expose no context, cause, or stack', async () => {
    const res = await app.request('/agents/broken/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
    })
    const events = await readSse(res)
    const errCrumb = events.find((e) => e.type === 'agent:error')
    expect(errCrumb).toBeDefined()
    const error = (errCrumb!.payload as { error: Record<string, unknown> }).error
    expect(Object.keys(error).sort()).toEqual(['code', 'message'])
  })
})

// toClientError isn't exported — exercised indirectly through app.onError, hit
// by an uncaught throw from a non-streaming route handler (the SSE run route
// above sanitizes separately, inside the transport).
describe('non-streaming error sanitization (toClientError)', () => {
  let app: Hono
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
    }))
  })

  afterEach(() => stop())

  test('an AggregateError thrown by a route maps to code AGGREGATE_ERROR', async () => {
    bread.store.listSessions = async () => {
      throw new AggregateError([new Error('a'), new Error('b')], 'multiple failures')
    }

    const res = await app.request('/sessions')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error).toEqual({ code: 'AGGREGATE_ERROR', message: 'multiple failures' })
  })

  test('an AggregateError with no message falls back to a generic message', async () => {
    bread.store.listSessions = async () => {
      throw new AggregateError([new Error('a')], '')
    }

    const res = await app.request('/sessions')
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error).toEqual({ code: 'AGGREGATE_ERROR', message: 'Multiple operations failed' })
  })

  test('an unknown error type maps to INTERNAL_ERROR without leaking its message', async () => {
    bread.store.listSessions = async () => {
      throw new Error('leaky internal detail')
    }

    const res = await app.request('/sessions')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
  })
})
