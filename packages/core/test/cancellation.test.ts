import { describe, expect, test } from 'bun:test'
import { BreadError } from '@bread/core'
import type { BreadCrumb } from '@bread/core'
import {
  defineTestAgent,
  makeBread,
  mockChunkedTextModel,
  mockScript,
  mockTextModel,
  runCollect,
  stream,
} from '@bread/test-utils'

// Manually drains an iterator, aborting right before the `abortAt`-th crumb is
// requested — deterministic without artificial delay, since each `.next()`
// call already crosses a real async tick.
async function drainAborting(
  it: AsyncIterator<BreadCrumb>,
  controller: AbortController,
  abortAt: number,
): Promise<{ crumbs: BreadCrumb[]; error: unknown }> {
  const crumbs: BreadCrumb[] = []
  let error: unknown
  for (let i = 0; ; i++) {
    if (i === abortAt) controller.abort()
    let result: IteratorResult<BreadCrumb>
    try {
      result = await it.next()
    } catch (err) {
      error = err
      break
    }
    if (result.done) break
    crumbs.push(result.value)
  }
  return { crumbs, error }
}

describe('run cancellation — AbortSignal', () => {
  test('aborting mid-stream ends the run with RUN_CANCELLED and does not retry', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({ config: { errorHandling: { retry: { attempts: 3, backoffMs: 5 } } } }),
      },
      model: mockChunkedTextModel(['a', 'b', 'c', 'd']),
    })
    try {
      const controller = new AbortController()
      const it = stream(bread, 'a', 'go', { signal: controller.signal })[Symbol.asyncIterator]()

      // Crumb 0 is agent:run:start, crumb 1 is the first text:delta ('a') —
      // abort right after that, before any further deltas arrive.
      const { crumbs, error } = await drainAborting(it, controller, 2)

      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('RUN_CANCELLED')

      const deltas = crumbs.filter((c) => c.type === 'text:delta') as { delta: string }[]
      // Only the delta(s) already in flight before the abort arrived — if a
      // retry had fired, this would restart the whole 4-chunk sequence.
      expect(deltas.map((d) => d.delta).join('')).toBe('a')
      expect(crumbs.map((c) => c.type)).toContain('agent:error')
      expect(crumbs.map((c) => c.type)).not.toContain('agent:run:end')
    } finally {
      await stop()
    }
  })

  test('aborting during a delegated sub-agent run cancels the whole supervisor run', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { supervisor: { agents: [{ agentId: 'child' }] } },
        }),
        child: defineTestAgent({ model: 'child' }),
      },
      models: {
        host: mockScript([{ tool: 'core_delegate', args: { agentId: 'child', input: 'go' } }, { text: 'never' }]),
        child: mockChunkedTextModel(['x', 'y']),
      },
    })
    try {
      const controller = new AbortController()
      const it = stream(bread, 'host', 'go', { signal: controller.signal })[Symbol.asyncIterator]()

      // Abort mid-delegation, after the child's first delta — the shared
      // signal reaches the child's in-flight model call through runAgent.
      const { crumbs, error } = await drainAborting(it, controller, 3)

      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('RUN_CANCELLED')
      // The supervisor never got to compose its final answer.
      expect(crumbs.map((c) => c.type)).not.toContain('agent:run:end')
    } finally {
      await stop()
    }
  })

  test('an abort that fires after the run has already completed is a no-op', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('done'),
    })
    try {
      const controller = new AbortController()
      const crumbs = await runCollect(bread, 'a', 'go', { signal: controller.signal })
      expect(crumbs.map((c) => c.type)).toContain('agent:run:end')

      // The run is long over — aborting now must not throw or affect anything.
      expect(() => controller.abort()).not.toThrow()
    } finally {
      await stop()
    }
  })
})
