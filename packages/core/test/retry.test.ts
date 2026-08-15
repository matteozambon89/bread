import { describe, expect, test } from 'bun:test'
import { withRetry } from '@breadai/core'

// backoffMs: 0 keeps these fast — no real waiting between attempts.
const fast = { attempts: 3, backoffMs: 0 }

describe('withRetry', () => {
  test('returns the result on the first successful attempt', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        return 'ok'
      },
      fast,
      'op',
    )
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  test('retries until an attempt succeeds', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('transient')
        return 'recovered'
      },
      fast,
      'op',
    )
    expect(result).toBe('recovered')
    expect(calls).toBe(3)
  })

  test('throws MAX_RETRIES_EXCEEDED after exhausting attempts, preserving the cause', async () => {
    const cause = new Error('always fails')
    const err = await withRetry(
      async () => {
        throw cause
      },
      fast,
      'flaky-op',
    ).catch((e) => e)
    expect(err.code).toBe('MAX_RETRIES_EXCEEDED')
    expect(err.context).toMatchObject({ attempts: 3, context: 'flaky-op' })
    expect(err.cause).toBe(cause)
  })

  test('defaults to a single attempt when no config is given', async () => {
    let calls = 0
    await withRetry(
      async () => {
        calls++
        throw new Error('x')
      },
      undefined,
      'op',
    ).catch(() => {})
    expect(calls).toBe(1)
  })
})
