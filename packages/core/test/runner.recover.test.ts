import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AgentRunEndCrumb } from '@breadai/core'
import {
  defineTestAgent,
  makeBread,
  mockErrorModel,
  mockTextModel,
  runCollect,
} from '@breadai/test-utils'

describe('runner — onError recover', () => {
  test('recovers a failed run via hooks.onError instead of throwing', async () => {
    // JSON output drives generateObject, which throws on the error model; the
    // onError hook catches it and its `recover` resolution supplies the output.
    const { bread, stop } = await makeBread({
      agents: {
        safe: defineTestAgent({
          config: {
            output: { format: 'json' },
            outputSchema: z.object({ ok: z.boolean() }),
            hooks: {
              onError: () => ({ action: 'recover', output: { ok: false, recovered: true } }),
            },
          },
        }),
      },
      model: mockErrorModel('model down'),
    })

    const crumbs = await runCollect(bread, 'safe', 'go')
    await stop()

    const end = crumbs.find((c) => c.type === 'agent:run:end') as AgentRunEndCrumb
    expect(end.output).toEqual({ ok: false, recovered: true })
    expect(crumbs.map((c) => c.type)).not.toContain('agent:error')
  })
})

describe('runner — sync mode', () => {
  test('returns the final output as a promise instead of a crumb stream', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('the answer'),
    })
    const { output } = await bread.run('a', 'go', { mode: 'sync' })
    await stop()
    expect(output).toBe('the answer')
  })
})
