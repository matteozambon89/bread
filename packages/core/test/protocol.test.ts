import { describe, expect, test } from 'bun:test'
import { BreadError } from '@bread/core'
import type { BreadCrumb } from '@bread/core'
import {
  BREAD_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type CrumbFrame,
  type SubscribeFrame,
} from '../src/protocol.js'

const sampleCrumb: BreadCrumb = {
  type: 'text:delta',
  agentId: 'a',
  runId: 'r1',
  sessionId: 's1',
  timestamp: 123,
  delta: 'hi',
} as BreadCrumb

describe('protocol — encodeFrame/decodeFrame round trip', () => {
  test('a crumb frame round-trips through encode/decode', () => {
    const frame: CrumbFrame = {
      v: BREAD_PROTOCOL_VERSION,
      type: 'crumb',
      runId: 'r1',
      seq: 1,
      crumb: sampleCrumb,
    }
    const decoded = decodeFrame(encodeFrame(frame))
    expect(decoded).toEqual(frame)
  })

  test('a subscribe frame round-trips through encode/decode', () => {
    const frame: SubscribeFrame = {
      v: BREAD_PROTOCOL_VERSION,
      type: 'subscribe',
      runId: 'r1',
      afterSeq: 5,
    }
    const decoded = decodeFrame(encodeFrame(frame))
    expect(decoded).toEqual(frame)
  })
})

describe('protocol — decodeFrame error branches', () => {
  function expectDecodeError(raw: string): void {
    expect(() => decodeFrame(raw)).toThrow(BreadError)
    try {
      decodeFrame(raw)
      throw new Error('expected decodeFrame to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('PROTOCOL_DECODE_ERROR')
    }
  }

  test('malformed JSON throws PROTOCOL_DECODE_ERROR', () => {
    expectDecodeError('{not valid json')
  })

  test('JSON that decodes to a non-object throws PROTOCOL_DECODE_ERROR', () => {
    expectDecodeError('"just a string"')
    expectDecodeError('42')
    expectDecodeError('null')
  })

  test('a missing/wrong version throws PROTOCOL_DECODE_ERROR', () => {
    expectDecodeError(JSON.stringify({ type: 'crumb', runId: 'r1', seq: 1, crumb: sampleCrumb }))
    expectDecodeError(
      JSON.stringify({ v: 999, type: 'crumb', runId: 'r1', seq: 1, crumb: sampleCrumb }),
    )
  })

  test('a missing runId throws PROTOCOL_DECODE_ERROR', () => {
    expectDecodeError(
      JSON.stringify({ v: BREAD_PROTOCOL_VERSION, type: 'crumb', seq: 1, crumb: sampleCrumb }),
    )
  })

  test('a crumb frame missing seq throws PROTOCOL_DECODE_ERROR', () => {
    expectDecodeError(
      JSON.stringify({ v: BREAD_PROTOCOL_VERSION, type: 'crumb', runId: 'r1', crumb: sampleCrumb }),
    )
  })

  test('a crumb frame missing crumb throws PROTOCOL_DECODE_ERROR', () => {
    expectDecodeError(
      JSON.stringify({ v: BREAD_PROTOCOL_VERSION, type: 'crumb', runId: 'r1', seq: 1 }),
    )
  })

  test('a subscribe frame missing afterSeq throws PROTOCOL_DECODE_ERROR', () => {
    expectDecodeError(JSON.stringify({ v: BREAD_PROTOCOL_VERSION, type: 'subscribe', runId: 'r1' }))
  })

  test('an unknown frame type throws PROTOCOL_DECODE_ERROR', () => {
    expectDecodeError(JSON.stringify({ v: BREAD_PROTOCOL_VERSION, type: 'ping', runId: 'r1' }))
  })
})
