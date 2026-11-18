import { Effect, Fiber, pipe, PubSub, Scheduler } from 'effect'
import type { BreadCrumb, HumanRequiredEvent, HumanRequiredHandler } from './types.js'

export type BreadEventMap = {
  crumb: BreadCrumb
  'human:required': HumanRequiredEvent
}

type AnyBreadEvent = {
  [K in keyof BreadEventMap]: { type: K; payload: BreadEventMap[K] }
}[keyof BreadEventMap]

type HandlerFn = (...args: unknown[]) => unknown

// publish resumes a waiting subscriber inline, and the default scheduler
// waits for setImmediate. Yielding onto the sync scheduler delivers on the
// next microtask, which is what listeners observed under Effect 3.
const scheduler = new Scheduler.MixedScheduler('sync')

export class BreadEventBus {
  private pubsub!: PubSub.PubSub<AnyBreadEvent>
  private dispatchFiber!: Fiber.Fiber<never, never>
  private handlers: Map<string, Set<HandlerFn>> = new Map()

  private constructor() {}

  static async create(): Promise<BreadEventBus> {
    const bus = new BreadEventBus()
    bus.pubsub = await Effect.runPromise(PubSub.unbounded<AnyBreadEvent>())
    bus.dispatchFiber = Effect.runFork(bus.dispatchLoop(), { scheduler })
    return bus
  }

  private dispatchLoop(): Effect.Effect<never, never, never> {
    const handlers = this.handlers
    return Effect.scoped(
      pipe(
        PubSub.subscribe(this.pubsub),
        Effect.flatMap((subscription) =>
          Effect.forever(
            pipe(
              PubSub.take(subscription),
              Effect.flatMap((event) =>
                Effect.sync(() => {
                  const set = handlers.get(event.type)
                  if (!set) return
                  for (const handler of set) {
                    try {
                      handler(event.payload)
                    } catch {
                      // handler errors must not crash the dispatch loop
                    }
                  }
                }),
              ),
            ),
          ),
        ),
      ),
    )
  }

  on<E extends keyof BreadEventMap>(event: E, handler: (payload: BreadEventMap[E]) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler as HandlerFn)
  }

  off(event: string, handler: HandlerFn): void {
    this.handlers.get(event)?.delete(handler)
  }

  emit<E extends keyof BreadEventMap>(event: E, payload: BreadEventMap[E]): void {
    Effect.runFork(
      Effect.andThen(
        Effect.yieldNow,
        PubSub.publish(this.pubsub, { type: event, payload } as AnyBreadEvent),
      ),
      { scheduler },
    )
  }

  async close(): Promise<void> {
    await Effect.runPromise(Fiber.interrupt(this.dispatchFiber))
  }
}
