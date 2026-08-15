import { afterEach, describe, expect, test } from 'bun:test'
import type { BreadCrumb } from '@breadai/core'
// BreadEventBus is an internal class (not re-exported from the package entry).
import { BreadEventBus } from '../src/event-bus.js'

// A minimal crumb payload — the bus forwards it opaquely, it is never inspected.
const crumb = { type: 'text-delta', delta: 'x' } as unknown as BreadCrumb

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// Delivery is async (Effect fiber); fail fast instead of hanging if it never lands.
function withTimeout<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('event not delivered')), ms)),
  ])
}

const tick = () => new Promise((r) => setTimeout(r, 50))

describe('BreadEventBus', () => {
  let bus: BreadEventBus

  afterEach(() => bus?.close())

  test('delivers an emitted event to a registered handler', async () => {
    bus = await BreadEventBus.create()
    const got = deferred<BreadCrumb>()
    bus.on('crumb', (c) => got.resolve(c))
    bus.emit('crumb', crumb)
    expect(await withTimeout(got.promise)).toBe(crumb)
  })

  test('delivers to every registered handler', async () => {
    bus = await BreadEventBus.create()
    const a = deferred()
    const b = deferred()
    bus.on('crumb', () => a.resolve())
    bus.on('crumb', () => b.resolve())
    bus.emit('crumb', crumb)
    await withTimeout(Promise.all([a.promise, b.promise]))
  })

  test('stops delivering to a handler removed with off', async () => {
    bus = await BreadEventBus.create()
    let removedCalls = 0
    const removed = () => removedCalls++
    const barrier = deferred()
    bus.on('crumb', removed)
    bus.on('crumb', () => barrier.resolve())
    bus.off('crumb', removed)
    bus.emit('crumb', crumb)
    // The barrier handler fires in the same dispatch pass, proving the event was
    // processed — yet the removed handler must not have run.
    await withTimeout(barrier.promise)
    expect(removedCalls).toBe(0)
  })

  test('a throwing handler does not break later delivery', async () => {
    bus = await BreadEventBus.create()
    let okCalls = 0
    bus.on('crumb', () => {
      throw new Error('handler boom')
    })
    bus.on('crumb', () => okCalls++)
    const second = deferred()
    bus.on('crumb', () => {
      if (okCalls >= 1) second.resolve()
    })
    bus.emit('crumb', crumb)
    bus.emit('crumb', crumb)
    await withTimeout(second.promise)
    expect(okCalls).toBeGreaterThanOrEqual(1)
  })

  test('close stops further delivery', async () => {
    bus = await BreadEventBus.create()
    let calls = 0
    bus.on('crumb', () => calls++)
    await bus.close()
    bus.emit('crumb', crumb)
    await tick()
    expect(calls).toBe(0)
  })
})
