import { describe, expect, test } from 'bun:test'
import { BreadError, fromWireCrumb, streamTransport, toWireCrumb } from '@bread/core'
import type { BreadCrumb, BusFrame, ToolErrorCrumb } from '@bread/core'

const crumb = (runId: string): BreadCrumb => ({
  type: 'agent:run:start',
  agentId: 'a',
  runId,
  sessionId: 's',
  timestamp: 1,
  input: 'go',
})

const frame = (runId: string, seq: number): BusFrame => ({ runId, seq, crumb: crumb(runId) })

describe('streamTransport', () => {
  test('delivers published frames to a subscriber of that run', () => {
    const transport = streamTransport()
    const got: BusFrame[] = []
    transport.subscribe!('r1', 0, (f) => got.push(f))
    transport.publish(frame('r1', 1))
    transport.publish(frame('r1', 2))
    expect(got.map((f) => f.seq)).toEqual([1, 2])
  })

  test('isolates runs — a subscriber never sees another run\'s frames', () => {
    const transport = streamTransport()
    const got: BusFrame[] = []
    transport.subscribe!('r1', 0, (f) => got.push(f))
    transport.publish(frame('r2', 1))
    expect(got).toHaveLength(0)
  })

  test('broadcasts one frame to every subscriber of the run', () => {
    const transport = streamTransport()
    let a = 0
    let b = 0
    transport.subscribe!('r1', 0, () => a++)
    transport.subscribe!('r1', 0, () => b++)
    transport.publish(frame('r1', 1))
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  test('unsubscribe stops delivery', () => {
    const transport = streamTransport()
    let calls = 0
    const unsub = transport.subscribe!('r1', 0, () => calls++)
    transport.publish(frame('r1', 1))
    unsub()
    transport.publish(frame('r1', 2))
    expect(calls).toBe(1)
  })

  test('a throwing handler neither reaches the publisher nor starves siblings', () => {
    const transport = streamTransport()
    let okCalls = 0
    transport.subscribe!('r1', 0, () => {
      throw new Error('bad handler')
    })
    transport.subscribe!('r1', 0, () => okCalls++)
    expect(() => transport.publish(frame('r1', 1))).not.toThrow()
    expect(okCalls).toBe(1)
  })

  test('subscribe(runId, afterSeq) replays buffered frames before tailing live', () => {
    const transport = streamTransport()
    transport.publish(frame('r1', 1))
    transport.publish(frame('r1', 2))
    transport.publish(frame('r1', 3))
    const got: number[] = []
    // Already has seq 1 — replay should start at 2.
    transport.subscribe!('r1', 1, (f) => got.push(f.seq))
    expect(got).toEqual([2, 3])
    transport.publish(frame('r1', 4))
    expect(got).toEqual([2, 3, 4])
  })
})

describe('toWireCrumb / fromWireCrumb', () => {
  const errorCrumb: ToolErrorCrumb = {
    type: 'tool:error',
    agentId: 'a',
    runId: 'r1',
    sessionId: 's',
    timestamp: 1,
    toolCallId: 'c1',
    toolName: 'boom',
    durationMs: 5,
    error: new BreadError('it broke', 'TOOL_ERROR', { toolName: 'boom' }, new Error('root cause')),
  }

  test('flattens a BreadError so the crumb survives a JSON round-trip', () => {
    const wire = toWireCrumb(errorCrumb)
    const parsed = JSON.parse(JSON.stringify(wire)) as ToolErrorCrumb
    const err = parsed.error as unknown as { name: string; code: string; message: string; context: unknown }
    expect(err.name).toBe('BreadError')
    expect(err.code).toBe('TOOL_ERROR')
    expect(err.message).toBe('it broke')
    expect(err.context).toEqual({ toolName: 'boom' })
    // cause/stack are dropped — they can hold non-JSON provider objects.
    expect('cause' in err).toBe(false)
    expect('stack' in err).toBe(false)
  })

  test('rebuilds a real BreadError from the wire form', () => {
    const roundTripped = JSON.parse(JSON.stringify(toWireCrumb(errorCrumb))) as BreadCrumb
    const restored = fromWireCrumb(roundTripped) as ToolErrorCrumb
    expect(restored.error).toBeInstanceOf(BreadError)
    expect(restored.error.code).toBe('TOOL_ERROR')
    expect(restored.error.message).toBe('it broke')
    expect(restored.error.context).toEqual({ toolName: 'boom' })
  })

  test('passes non-error crumbs through unchanged', () => {
    const c = crumb('r1')
    expect(toWireCrumb(c)).toBe(c)
    expect(fromWireCrumb(c)).toBe(c)
  })
})
