import { describe, expect, test } from 'bun:test'
import { toClientError } from '../src/sse.js'

describe('@breadai/transport-http-sse — sse.ts toClientError', () => {
  test('an AggregateError sanitizes to an AGGREGATE_ERROR client shape', () => {
    const err = new AggregateError([new Error('a'), new Error('b')], 'multiple failures')
    expect(toClientError(err)).toEqual({ code: 'AGGREGATE_ERROR', message: 'multiple failures' })
  })

  test('an AggregateError with no message falls back to a generic one', () => {
    const err = new AggregateError([new Error('a'), new Error('b')])
    expect(toClientError(err)).toEqual({ code: 'AGGREGATE_ERROR', message: 'Multiple operations failed' })
  })

  test('any other error sanitizes to a generic INTERNAL_ERROR, never leaking its message', () => {
    expect(toClientError(new Error('leaky internal detail'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    })
  })
})
