import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AgentRunEndCrumb, BreadInstance } from '@breadai/core'
import { defineTestAgent, makeBread, mockObjectModel, runCollect } from '@breadai/test-utils'

describe('runner — structured (json) output', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    const schema = z.object({ city: z.string(), pop: z.number() })
    ;({ bread, stop } = await makeBread({
      agents: {
        extract: defineTestAgent({
          config: { output: { format: 'json' }, outputSchema: schema },
        }),
      },
      model: mockObjectModel({ city: 'Rome', pop: 3 }),
    }))
  })

  afterEach(() => stop())

  test('returns the generated object as the run output', async () => {
    const crumbs = await runCollect(bread, 'extract', 'rome?')
    const end = crumbs.find((c) => c.type === 'agent:run:end') as AgentRunEndCrumb
    expect(end.output).toEqual({ city: 'Rome', pop: 3 })
  })

  test('does not stream text deltas on the structured path', async () => {
    const crumbs = await runCollect(bread, 'extract', 'rome?')
    expect(crumbs.map((c) => c.type)).not.toContain('text:delta')
  })
})
