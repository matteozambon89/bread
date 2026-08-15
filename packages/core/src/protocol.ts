import type { BreadCrumb } from './types.js'
import { BreadError } from './types.js'
import { fromWireCrumb, toWireCrumb } from './transport.js'

// The Bread protocol: the wire envelope duplex transports speak when frames
// cross a network boundary (an HTTP chunked/SSE connection, a remote-agent
// call, …): a versioned frame shape, seq semantics (see BusFrame in
// transport.ts), and a catch-up handshake a client sends once on (re)connect
// to request replay from a given point.
//
// This module defines the envelope and its encoder/decoder; concrete
// conformers are @breadai/transport-http-chunked (NDJSON CrumbFrame lines) and,
// for the SSE wire format specifically, @breadai/transport-http-sse's own ad
// hoc `{ type, payload }` framing predates this module and isn't rewritten
// onto it (a deliberate wire-compatibility choice — see that package).

export const BREAD_PROTOCOL_VERSION = 1

// A crumb frame — one entry of a run's crumb stream, wire-safe (errors
// flattened via toWireCrumb/fromWireCrumb, same as BusFrame).
export interface CrumbFrame {
  v: typeof BREAD_PROTOCOL_VERSION
  type: 'crumb'
  runId: string
  seq: number
  crumb: BreadCrumb
}

// The catch-up handshake: sent once by a client (re)connecting to a run's
// stream, asking the peer to replay frames with `seq > afterSeq` before
// tailing live. `afterSeq: 0` requests everything the peer still retains.
// Mirrors today's `Last-Event-ID` header / `?after=` query param, generalized
// to any duplex transport's wire encoding, not just HTTP/SSE.
export interface SubscribeFrame {
  v: typeof BREAD_PROTOCOL_VERSION
  type: 'subscribe'
  runId: string
  afterSeq: number
}

export type BreadProtocolFrame = CrumbFrame | SubscribeFrame

function decodeError(reason: string, raw: string): never {
  throw new BreadError(`Malformed Bread protocol frame: ${reason}`, 'PROTOCOL_DECODE_ERROR', {
    raw: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw,
  })
}

// Serializes a frame for the wire. Crumb frames flatten any live BreadError
// on `error` the same way BusFrame does (see toWireCrumb).
export function encodeFrame(frame: BreadProtocolFrame): string {
  if (frame.type === 'crumb') {
    return JSON.stringify({ ...frame, crumb: toWireCrumb(frame.crumb) })
  }
  return JSON.stringify(frame)
}

// Parses one wire frame, validating shape and version. Throws
// PROTOCOL_DECODE_ERROR (not a bare SyntaxError/TypeError) on anything
// malformed, so a transport's read loop gets one error type to handle.
export function decodeFrame(raw: string): BreadProtocolFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    decodeError('invalid JSON', raw)
  }
  if (typeof parsed !== 'object' || parsed === null) decodeError('not an object', raw)
  const obj = parsed as Record<string, unknown>

  if (obj['v'] !== BREAD_PROTOCOL_VERSION) {
    decodeError(`unsupported version "${String(obj['v'])}" (expected ${BREAD_PROTOCOL_VERSION})`, raw)
  }
  if (typeof obj['runId'] !== 'string') decodeError('missing "runId"', raw)

  if (obj['type'] === 'crumb') {
    if (typeof obj['seq'] !== 'number' || obj['crumb'] === undefined) {
      decodeError('crumb frame missing "seq"/"crumb"', raw)
    }
    return {
      v: BREAD_PROTOCOL_VERSION,
      type: 'crumb',
      runId: obj['runId'] as string,
      seq: obj['seq'] as number,
      crumb: fromWireCrumb(obj['crumb'] as BreadCrumb),
    }
  }
  if (obj['type'] === 'subscribe') {
    if (typeof obj['afterSeq'] !== 'number') decodeError('subscribe frame missing "afterSeq"', raw)
    return {
      v: BREAD_PROTOCOL_VERSION,
      type: 'subscribe',
      runId: obj['runId'] as string,
      afterSeq: obj['afterSeq'] as number,
    }
  }
  decodeError(`unknown frame type "${String(obj['type'])}"`, raw)
}
