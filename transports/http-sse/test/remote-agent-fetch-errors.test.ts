import { describe, expect, test } from 'bun:test'
import { BreadError } from '@bread/core'
import { remoteAgent } from '@bread/transport-http-sse'

// Unit-level coverage of remoteAgent()'s internal streamAttempt()/sleep()
// helpers — neither is exported, so exercised through a stubbed global fetch
// passed to the public run() API instead of imported directly.
describe('@bread/transport-http-sse — remoteAgent() fetch error paths', () => {
  test('a non-ok HTTP status throws REMOTE_AGENT_ERROR immediately, without retrying', async () => {
    let calls = 0
    const stubFetch = (async () => {
      calls++
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' })
    }) as typeof fetch

    const agent = remoteAgent({ url: 'http://test', fetch: stubFetch, maxRetries: 3, retryDelayMs: 5 })
    let thrown: unknown
    try {
      for await (const _crumb of agent.run('greeter', 'hi')) {
        // draining is enough to trigger the throw
      }
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(BreadError)
    expect((thrown as BreadError).code).toBe('REMOTE_AGENT_ERROR')
    expect(calls).toBe(1) // a definitive rejection — never retried
  })

  test('an empty response body throws REMOTE_AGENT_ERROR', async () => {
    const stubFetch = (async () => new Response(null, { status: 200 })) as typeof fetch

    const agent = remoteAgent({ url: 'http://test', fetch: stubFetch })
    let thrown: unknown
    try {
      for await (const _crumb of agent.run('greeter', 'hi')) {
        // draining is enough to trigger the throw
      }
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(BreadError)
    expect((thrown as BreadError).code).toBe('REMOTE_AGENT_ERROR')
  })

  test('aborting mid-retry-backoff resolves promptly instead of waiting the full delay', async () => {
    const stubFetch = (async () => {
      throw new Error('simulated network error') // not a BreadError — falls into the retry path
    }) as typeof fetch

    const controller = new AbortController()
    const agent = remoteAgent({ url: 'http://test', fetch: stubFetch, maxRetries: 5, retryDelayMs: 5000 })

    const start = Date.now()
    setTimeout(() => controller.abort(), 20)

    let thrown: unknown
    try {
      for await (const _crumb of agent.run('greeter', 'hi', { signal: controller.signal })) {
        // draining is enough to trigger the throw
      }
    } catch (err) {
      thrown = err
    }
    const elapsed = Date.now() - start

    expect(thrown).toBeInstanceOf(BreadError)
    expect((thrown as BreadError).code).toBe('RUN_CANCELLED')
    // Well under the 5000ms retryDelayMs — the abort listener woke sleep() early.
    expect(elapsed).toBeLessThan(1000)
  })
})
